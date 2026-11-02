import { hasReviewMarker, isUnprocessableError, postReview } from './github.js';
import { quoteFindings } from './quote.js';
import { buildReviewPost, renderReview } from './render.js';
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
        const { truncated, diffLines, diffLineRanges } = workspace;
        let output;
        let quotes;
        try {
            log(`${engine} 리뷰 실행 (변경 파일 ${workspace.changedFiles.length}개, diff ${workspace.diffLines}줄)`);
            const prompt = buildReviewPrompt(pr, workspace);
            output = engine === 'claude'
                ? await reviewWithClaude(workspace, prompt, settings)
                : await reviewWithCodex(workspace, prompt, settings);
            // 작업 공간을 지우기 전에 지적한 코드를 읽어 둔다.
            quotes = await quoteFindings(workspace.dir, output.result.findings);
        }
        finally {
            await cleanup();
        }
        const durationMs = Date.now() - startedAt;
        const renderInput = {
            pr,
            sha,
            engine,
            model: output.model,
            durationMs,
            result: output.result,
            quotes,
            truncated,
            diffLines,
        };
        // 로컬 파일·표준 출력에는 모든 지적을 인용과 함께 담는다. PR에 올리는 내용은 이 본문의 일부다.
        const body = renderReview(renderInput);
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
                commentUrl = await publishReview(pr, sha, buildReviewPost(renderInput, diffLineRanges), body, log);
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
/**
 * 지적마다 코드 줄 코멘트를 단 PR 리뷰를 올린다.
 * GitHub가 코멘트 위치나 커밋을 받지 않으면(HTTP 422, 리뷰는 만들어지지 않음) 모든 지적을 본문에 담아 커밋 지정 없이 다시 올린다.
 * 줄 범위 계산이 GitHub diff와 다르거나, 리뷰 중에 강제 푸시로 커밋이 PR에서 빠진 경우다.
 */
async function publishReview(pr, sha, post, fullBody, log) {
    try {
        const url = await postReview(pr.repo, pr.number, post, sha);
        log(`PR 리뷰 게시: 코드 줄 코멘트 ${post.comments.length}건`);
        return url;
    }
    catch (error) {
        if (!isUnprocessableError(error))
            throw error;
        log(`경고: GitHub가 리뷰 요청을 받지 않아(HTTP 422) 모든 지적을 리뷰 본문에 넣어 다시 게시합니다. ${error instanceof Error ? error.message : ''}`);
        return postReview(pr.repo, pr.number, { body: fullBody, comments: [] }, null);
    }
}
