import { run } from '../exec.js';
import { parseReviewResult, REVIEW_SCHEMA } from './schema.js';
// AI가 쓸 수 있는 도구를 읽기 도구로만 한정한다. Bash는 넣지 않는다.
// `Bash(git diff:*)`처럼 접두어로 허용하면 `git diff --output=<경로>`로 파일을 쓸 수 있기 때문이다.
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
export function buildClaudeArgs(settings, dataDir) {
    const args = [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(REVIEW_SCHEMA),
        '--no-session-persistence',
        // MCP 서버(Slack, DB 등)를 리뷰 실행에 연결하지 않는다.
        '--strict-mcp-config',
        '--setting-sources',
        settings.claudeSettingSources,
        // worktree 밖에 둔 전체 diff 파일을 읽을 수 있게 한다.
        '--add-dir',
        dataDir,
    ];
    if (settings.model)
        args.push('--model', settings.model);
    if (settings.maxBudgetUsd !== null)
        args.push('--max-budget-usd', String(settings.maxBudgetUsd));
    // 가변 인자 옵션은 마지막에 둔다.
    args.push('--tools', ...READ_ONLY_TOOLS, '--allowed-tools', ...READ_ONLY_TOOLS);
    return args;
}
export async function reviewWithClaude(workspace, prompt, settings) {
    const result = await run('claude', buildClaudeArgs(settings, workspace.dataDir), {
        cwd: workspace.dir,
        input: prompt,
        timeoutMs: settings.timeoutSec * 1000,
    });
    if (result.timedOut)
        throw new Error(`Claude 리뷰가 ${settings.timeoutSec}초 안에 끝나지 않았습니다.`);
    let output;
    try {
        output = JSON.parse(result.stdout);
    }
    catch {
        throw new Error(`Claude 출력이 JSON이 아닙니다 (종료 코드 ${result.code}): ${result.stderr.trim().slice(-500)}`);
    }
    if (output['is_error'] === true || output['subtype'] !== 'success') {
        const detail = typeof output['result'] === 'string' ? output['result'].slice(0, 500) : '';
        throw new Error(`Claude 리뷰 실패 (${String(output['subtype'])}): ${detail}`);
    }
    const structured = output['structured_output'] ?? JSON.parse(String(output['result']));
    const modelUsage = output['modelUsage'];
    const usedModels = modelUsage && typeof modelUsage === 'object' ? Object.keys(modelUsage) : [];
    return {
        result: parseReviewResult(structured),
        model: usedModels.join(', ') || settings.model || 'default',
        costUsd: typeof output['total_cost_usd'] === 'number' ? output['total_cost_usd'] : null,
    };
}
