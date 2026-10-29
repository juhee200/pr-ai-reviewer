import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRepo } from './config.js';
import { run, runOk } from './exec.js';
const GIT_TIMEOUT_MS = 10 * 60_000;
// 한글 파일 이름이 \352\270... 처럼 이스케이프되지 않게 한다.
const GIT_BASE_ARGS = ['-c', 'core.quotePath=false'];
function repoDirName(repo) {
    return validateRepo(repo).replace('/', '__');
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
/** 저장소별 캐시 bare 저장소를 준비한다. 개발자가 작업 중인 clone은 쓰지 않는다. */
export async function ensureMirror(cacheDir, repo) {
    const dir = join(cacheDir, 'repos', `${repoDirName(repo)}.git`);
    if (await exists(join(dir, 'HEAD')))
        return dir;
    // 이전에 clone이 중간에 실패해 남은 디렉터리가 있으면 지우고 다시 받는다.
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(cacheDir, 'repos'), { recursive: true });
    // 파일 내용(blob)은 필요할 때 받는다. 인증은 기존 git https 자격 증명을 그대로 쓴다.
    await runOk('git', ['clone', '--bare', '--filter=blob:none', '--quiet', `https://github.com/${repo}.git`, dir], {
        timeoutMs: GIT_TIMEOUT_MS,
    });
    return dir;
}
async function fetchPullRefs(mirror, pr, sha) {
    await runOk('git', [
        '-C',
        mirror,
        'fetch',
        '--quiet',
        '--no-tags',
        'origin',
        `+refs/pull/${pr.number}/head:refs/prr/pull/${pr.number}`,
        `+refs/heads/${pr.baseRef}:refs/prr/base/${pr.number}`,
    ], { timeoutMs: GIT_TIMEOUT_MS });
    // 목록을 조회한 뒤 강제 푸시됐거나 평가용으로 과거 커밋을 지정한 경우 그 커밋을 직접 받는다.
    const hasCommit = await run('git', ['-C', mirror, 'cat-file', '-e', `${sha}^{commit}`]);
    if (hasCommit.code !== 0) {
        await runOk('git', ['-C', mirror, 'fetch', '--quiet', '--no-tags', 'origin', sha], { timeoutMs: GIT_TIMEOUT_MS });
    }
}
export function truncateLines(text, maxLines) {
    const lines = text === '' ? [] : text.split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    if (lines.length <= maxLines)
        return { text, lines: lines.length, truncated: false };
    return { text: `${lines.slice(0, maxLines).join('\n')}\n`, lines: lines.length, truncated: true };
}
export async function prepareWorkspace(cacheDir, pr, sha, maxDiffLines) {
    const mirror = await ensureMirror(cacheDir, pr.repo);
    await fetchPullRefs(mirror, pr, sha);
    const mergeBase = (await runOk('git', ['-C', mirror, 'merge-base', `refs/prr/base/${pr.number}`, sha], { timeoutMs: GIT_TIMEOUT_MS })).trim();
    const worktreeRoot = join(cacheDir, 'worktrees');
    await mkdir(worktreeRoot, { recursive: true });
    const dir = join(worktreeRoot, `${repoDirName(pr.repo)}__${pr.number}__${sha.slice(0, 7)}__${randomBytes(3).toString('hex')}`);
    await runOk('git', ['-C', mirror, 'worktree', 'add', '--detach', '--quiet', dir, sha], { timeoutMs: GIT_TIMEOUT_MS });
    const dataDir = await mkdtemp(join(tmpdir(), 'pr-ai-reviewer-data-'));
    const cleanup = async () => {
        await run('git', ['-C', mirror, 'worktree', 'remove', '--force', dir]);
        await rm(dir, { recursive: true, force: true });
        await rm(dataDir, { recursive: true, force: true });
        await run('git', ['-C', mirror, 'worktree', 'prune']);
    };
    try {
        const diffArgs = [...GIT_BASE_ARGS, '-C', dir, 'diff', '--no-color', '--no-ext-diff', mergeBase, sha];
        const [rawDiff, nameOnly, diffStat] = await Promise.all([
            runOk('git', diffArgs, { timeoutMs: GIT_TIMEOUT_MS }),
            runOk('git', [...diffArgs, '--name-only'], { timeoutMs: GIT_TIMEOUT_MS }),
            runOk('git', [...diffArgs, '--stat=200'], { timeoutMs: GIT_TIMEOUT_MS }),
        ]);
        const truncated = truncateLines(rawDiff, maxDiffLines);
        // AI가 git 명령 없이도 전체 diff를 읽을 수 있게 파일로 둔다.
        const fullDiffPath = join(dataDir, 'pr.diff');
        await writeFile(fullDiffPath, rawDiff, 'utf8');
        return {
            workspace: {
                dir,
                headSha: sha,
                mergeBase,
                changedFiles: nameOnly.split('\n').filter((line) => line !== ''),
                diffStat: diffStat.trimEnd(),
                diff: truncated.text,
                diffLines: truncated.lines,
                truncated: truncated.truncated,
                dataDir,
                fullDiffPath,
            },
            cleanup,
        };
    }
    catch (error) {
        await cleanup();
        throw error;
    }
}
