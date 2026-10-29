import { hasReviewMarker, postComment } from './github.js';
import { renderReview } from './render.js';
import { reviewWithClaude } from './review/claude.js';
import { reviewWithCodex } from './review/codex.js';
import { buildReviewPrompt } from './review/prompt.js';
import { countBySeverity } from './review/schema.js';
import { appendRunLog, saveReviewFile } from './runlog.js';
import { findSecrets } from './secrets.js';
import { prepareWorkspace } from './workspace.js';
export async function reviewPullRequest(config, request, log) {
    const { pr, engine, dryRun } = request;
    const sha = request.sha ?? pr.headSha;
    const startedAt = Date.now();
    const settings = {
        model: request.model,
        maxBudgetUsd: config.maxBudgetUsd,
        timeoutSec: config.timeoutSec,
        claudeSettingSources: config.claudeSettingSources,
    };
    try {
        log(`작업 공간 준비: ${pr.repo}#${pr.number} @ ${sha.slice(0, 7)}`);
        const { workspace, cleanup } = await prepareWorkspace(config.cacheDir, pr, sha, config.maxDiffLines);
        const { truncated, diffLines } = workspace;
        let output;
        try {
            log(`${engine} 리뷰 실행 (변경 파일 ${workspace.changedFiles.length}개, diff ${workspace.diffLines}줄)`);
            const prompt = buildReviewPrompt(pr, workspace);
            output = engine === 'claude'
                ? await reviewWithClaude(workspace, prompt, settings)
                : await reviewWithCodex(workspace, prompt, settings);
        }
        finally {
            await cleanup();
        }
        const durationMs = Date.now() - startedAt;
        const body = renderReview({
            pr,
            sha,
            engine,
            model: output.model,
            durationMs,
            result: output.result,
            truncated,
            diffLines,
        });
        const outputPath = await saveReviewFile(config.stateDir, pr.repo, pr.number, sha, body);
        const counts = countBySeverity(output.result.findings);
        let posted = false;
        let commentUrl = null;
        let skippedReason;
        const secrets = findSecrets(body);
        if (secrets.length > 0) {
            // 본문은 로컬 파일로만 남기고 PR에는 올리지 않는다.
            skippedReason = `리뷰 본문에 비밀값으로 보이는 문자열(${secrets.join(', ')})이 있어 게시하지 않음`;
            log(`경고: ${skippedReason}. 로컬 파일을 확인하세요: ${outputPath}`);
        }
        else if (!dryRun) {
            if (await hasReviewMarker(pr.repo, pr.number, sha)) {
                skippedReason = '같은 커밋의 리뷰가 이미 PR에 있음';
            }
            else {
                commentUrl = await postComment(pr.repo, pr.number, body);
                posted = true;
            }
        }
        await appendRunLog(config.stateDir, {
            at: new Date().toISOString(),
            repo: pr.repo,
            pr: pr.number,
            title: pr.title,
            url: pr.url,
            sha,
            engine,
            model: output.model,
            dryRun,
            ok: true,
            durationMs,
            costUsd: output.costUsd,
            counts,
            posted,
            ...(commentUrl ? { commentUrl } : {}),
            outputPath,
        });
        return {
            body,
            outputPath,
            posted,
            commentUrl,
            ...(skippedReason ? { skippedReason } : {}),
            counts,
            durationMs,
            model: output.model,
            costUsd: output.costUsd,
        };
    }
    catch (error) {
        await appendRunLog(config.stateDir, {
            at: new Date().toISOString(),
            repo: pr.repo,
            pr: pr.number,
            title: pr.title,
            url: pr.url,
            sha,
            engine,
            model: request.model,
            dryRun,
            ok: false,
            durationMs: Date.now() - startedAt,
            costUsd: null,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}
