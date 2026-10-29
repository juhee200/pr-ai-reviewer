#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { defaultConfigPath, loadConfig, validateModel, validatePrNumber, validateRepo, writeDefaultConfig, } from './config.js';
import { killActiveChildren } from './exec.js';
import { getPr, hasReviewMarker, listMyOpenPrs } from './github.js';
import { reviewPullRequest } from './reviewer.js';
import { SEVERITIES } from './review/schema.js';
import { markFailed, markReviewed, schedule } from './scheduler.js';
import { installService, serviceStatus, uninstallService } from './service.js';
import { loadState, saveState } from './state.js';
const HELP = `pr-ai-reviewer: 내가 올린 PR을 이 PC의 Claude Code 또는 Codex로 리뷰합니다.

사용법
  pr-ai-reviewer init                         설정 파일을 만듭니다
  pr-ai-reviewer review <owner/repo> <번호>   PR 하나를 지금 리뷰합니다
  pr-ai-reviewer run                          내 열린 PR을 감시하며 새 커밋마다 리뷰합니다
  pr-ai-reviewer status                       대기 중인 PR과 리뷰 기록을 보여줍니다
  pr-ai-reviewer service install [--post]     로그인 시 자동 실행으로 등록합니다 (macOS)
  pr-ai-reviewer service uninstall            자동 실행 등록을 해제합니다
  pr-ai-reviewer service status               자동 실행 상태와 최근 로그를 보여줍니다

옵션
  --config <경로>         설정 파일 (기본: ${defaultConfigPath()})
  --engine <claude|codex> 리뷰 엔진 (기본: 설정값)
  --model <이름>          엔진 모델 (기본: 설정값 또는 CLI 기본 모델)
  --dry-run               PR에 게시하지 않고 출력·파일 저장만 합니다
  --post                  PR에 리뷰 코멘트를 게시합니다
  --once                  run: 한 번만 조회하고 끝냅니다
  --plan                  run: 리뷰하지 않고 판정 결과만 보여줍니다
  --sha <커밋>            review: 지정한 커밋 기준으로 리뷰합니다 (평가용)
  -h, --help              도움말
`;
const ACTION_LABEL = { review: '리뷰 예정', wait: '대기', skip: '건너뜀' };
const SHA_PATTERN = /^[0-9a-f]{40}$/;
function log(message) {
    const time = new Date().toTimeString().slice(0, 8);
    // 로그는 stderr로 보내고, stdout에는 리뷰 본문만 쓴다.
    console.error(`[${time}] ${message}`);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function formatCounts(counts) {
    return SEVERITIES.map((severity) => `${severity} ${counts[severity]}`).join(' · ');
}
// 종료 신호를 받으면 실행 중인 AI·git 프로세스를 멈추고 worktree를 정리한 뒤 끝낸다.
const controller = new AbortController();
let interrupted = false;
function onSignal(signal) {
    if (interrupted)
        process.exit(130);
    interrupted = true;
    log(`${signal} 수신: 실행 중인 작업을 정리하고 종료합니다. 한 번 더 누르면 즉시 종료합니다.`);
    controller.abort();
    killActiveChildren();
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
function resolveDryRun(values, config) {
    if (values.post && values['dry-run'])
        throw new Error('--post와 --dry-run은 함께 쓸 수 없습니다.');
    if (values.post)
        return false;
    if (values['dry-run'])
        return true;
    return config.dryRun;
}
function resolveEngine(values, config) {
    if (values.engine === undefined)
        return config.engine;
    if (values.engine !== 'claude' && values.engine !== 'codex')
        throw new Error('--engine은 claude 또는 codex여야 합니다.');
    return values.engine;
}
function resolveModel(values, config) {
    return values.model === undefined ? config.model : validateModel(values.model);
}
function ensureReposConfigured(config, configPath) {
    if (config.repos.length === 0 || config.repos.includes('owner/name')) {
        throw new Error(`설정 파일의 repos에 감시할 저장소를 넣으세요: ${configPath}`);
    }
}
async function acquireLock(stateDir) {
    await mkdir(stateDir, { recursive: true });
    const path = join(stateDir, 'run.lock');
    try {
        await writeFile(path, String(process.pid), { flag: 'wx' });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        const pid = Number((await readFile(path, 'utf8')).trim());
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
            throw new Error(`이미 실행 중입니다 (PID ${pid}). 잠금 파일: ${path}`);
        }
        // 비정상 종료로 남은 잠금 파일이다.
        await writeFile(path, String(process.pid));
    }
    return () => rm(path, { force: true });
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
async function commandInit(configPath) {
    const created = await writeDefaultConfig(configPath);
    console.log(created
        ? `설정 파일을 만들었습니다: ${configPath}\nrepos를 감시할 저장소(owner/name)로 바꾼 뒤 run을 실행하세요.`
        : `설정 파일이 이미 있습니다: ${configPath}`);
}
async function commandReview(config, values, args) {
    const [repoArg, numberArg] = args;
    if (repoArg === undefined || numberArg === undefined)
        throw new Error('사용법: pr-ai-reviewer review <owner/repo> <번호>');
    const repo = validateRepo(repoArg);
    const number = validatePrNumber(numberArg);
    if (values.sha !== undefined && !SHA_PATTERN.test(values.sha))
        throw new Error('--sha는 40자리 커밋 SHA여야 합니다.');
    const dryRun = resolveDryRun(values, config);
    const pr = await getPr(repo, number);
    const outcome = await reviewPullRequest(config, { pr, sha: values.sha, engine: resolveEngine(values, config), model: resolveModel(values, config), dryRun }, log);
    process.stdout.write(`${outcome.body}\n`);
    log(`결과: ${formatCounts(outcome.counts)} · 저장 ${outcome.outputPath}`);
    if (outcome.posted)
        log('PR에 게시했습니다.');
    else
        log(dryRun ? 'dry-run이라 PR에 게시하지 않았습니다.' : `게시하지 않음: ${outcome.skippedReason ?? ''}`);
}
async function pollOnce(config, values, statePath) {
    const dryRun = resolveDryRun(values, config);
    const engine = resolveEngine(values, config);
    const model = resolveModel(values, config);
    let state = await loadState(statePath);
    for (const repo of config.repos) {
        if (controller.signal.aborted)
            return;
        let prs;
        try {
            prs = await listMyOpenPrs(repo);
        }
        catch (error) {
            log(`${repo} PR 조회 실패: ${errorMessage(error)}`);
            continue;
        }
        const scheduled = schedule(repo, prs, state, new Date(), { ...config, postMode: !dryRun });
        if (values.plan) {
            if (scheduled.decisions.length === 0)
                log(`${repo}: 내 열린 PR 없음`);
            for (const { pr, action, reason } of scheduled.decisions) {
                log(`${repo}#${pr.number}${pr.isDraft ? ' (Draft)' : ''} ${ACTION_LABEL[action]}: ${reason} · ${pr.title}`);
            }
            // --plan은 조회만 하고 상태를 바꾸지 않는다.
            continue;
        }
        state = scheduled.state;
        for (const { pr, action, reason } of scheduled.decisions) {
            if (action === 'wait')
                log(`${repo}#${pr.number} ${ACTION_LABEL[action]}: ${reason}`);
            if (action !== 'review')
                continue;
            if (controller.signal.aborted)
                break;
            try {
                if (!dryRun && (await hasReviewMarker(repo, pr.number, pr.headSha))) {
                    log(`${repo}#${pr.number}: 같은 커밋의 리뷰가 이미 PR에 있어 건너뜁니다.`);
                    state = markReviewed(state, repo, pr.number, pr.headSha, new Date(), 'post');
                }
                else {
                    const outcome = await reviewPullRequest(config, { pr, engine, model, dryRun }, log);
                    state = markReviewed(state, repo, pr.number, pr.headSha, new Date(), dryRun ? 'dry-run' : 'post');
                    log(`${repo}#${pr.number} 리뷰 완료: ${formatCounts(outcome.counts)} · ` +
                        `${outcome.posted ? 'PR에 게시' : 'dry-run 저장'} ${outcome.outputPath}`);
                    if (dryRun)
                        process.stdout.write(`${outcome.body}\n`);
                }
            }
            catch (error) {
                state = markFailed(state, repo, pr.number, pr.headSha, new Date());
                log(`${repo}#${pr.number} 리뷰 실패: ${errorMessage(error)}`);
            }
            await saveState(statePath, state);
        }
        await saveState(statePath, state);
    }
}
async function commandRun(config, values, configPath) {
    ensureReposConfigured(config, configPath);
    const statePath = join(config.stateDir, 'state.json');
    const release = await acquireLock(config.stateDir);
    try {
        const mode = values.plan ? '판정만' : resolveDryRun(values, config) ? 'dry-run' : 'PR 게시';
        log(`감시 시작: ${config.repos.join(', ')} · ${config.pollIntervalSec}초 간격 · ${mode} · 엔진 ${resolveEngine(values, config)}`);
        while (!controller.signal.aborted) {
            await pollOnce(config, values, statePath);
            if (values.once || values.plan)
                break;
            try {
                await sleep(config.pollIntervalSec * 1000, undefined, { signal: controller.signal });
            }
            catch {
                break;
            }
        }
    }
    finally {
        await release();
    }
}
async function commandStatus(config) {
    const state = await loadState(join(config.stateDir, 'state.json'));
    const pending = Object.entries(state.pending);
    const reviewed = Object.entries(state.reviewed);
    console.log(`대기 중 ${pending.length}건`);
    for (const [key, entry] of pending) {
        console.log(`  ${key} @ ${entry.sha.slice(0, 7)} · 처음 본 시각 ${entry.firstSeenAt} · 실패 ${entry.failures}회`);
    }
    console.log(`리뷰 기록 ${reviewed.length}건`);
    for (const [key, entry] of reviewed) {
        console.log(`  ${key} @ ${entry.sha.slice(0, 7)} · ${entry.at}`);
    }
}
async function commandService(values, args, configPath) {
    const [action] = args;
    if (action === 'install') {
        // 등록 전에 설정을 검증해, 잘못된 설정으로 자동 실행이 재시작을 반복하지 않게 한다.
        const absoluteConfigPath = resolve(configPath);
        const config = await loadConfig(absoluteConfigPath);
        ensureReposConfigured(config, absoluteConfigPath);
        const dryRun = resolveDryRun(values, config);
        const runArgs = ['run', dryRun ? '--dry-run' : '--post', '--config', absoluteConfigPath];
        if (values.engine !== undefined)
            runArgs.push('--engine', resolveEngine(values, config));
        if (values.model !== undefined)
            runArgs.push('--model', validateModel(values.model));
        await installService(runArgs, log);
        log(dryRun ? 'dry-run 모드로 등록했습니다. PR에 게시하지 않습니다.' : 'PR 게시 모드로 등록했습니다.');
        return;
    }
    if (action === 'uninstall')
        return uninstallService(log);
    if (action === 'status') {
        const status = await serviceStatus();
        console.log(status.loaded ? `등록됨 · 상태 ${status.state ?? '알 수 없음'}${status.pid ? ` · PID ${status.pid}` : ''} · 마지막 종료 코드 ${status.lastExitCode ?? '-'}` : '등록되지 않음');
        console.log(`최근 로그\n${status.logTail}`);
        return;
    }
    throw new Error('사용법: pr-ai-reviewer service <install|uninstall|status>');
}
async function main() {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        strict: true,
        options: {
            config: { type: 'string' },
            engine: { type: 'string' },
            model: { type: 'string' },
            'dry-run': { type: 'boolean' },
            post: { type: 'boolean' },
            once: { type: 'boolean' },
            plan: { type: 'boolean' },
            sha: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    const [command, ...args] = positionals;
    if (values.help || command === undefined || command === 'help') {
        console.log(HELP);
        return;
    }
    const configPath = values.config ?? defaultConfigPath();
    if (command === 'init')
        return commandInit(configPath);
    if (command === 'service')
        return commandService(values, args, configPath);
    const config = await loadConfig(configPath);
    switch (command) {
        case 'review':
            return commandReview(config, values, args);
        case 'run':
            return commandRun(config, values, configPath);
        case 'status':
            return commandStatus(config);
        default:
            throw new Error(`알 수 없는 명령입니다: ${command}\n\n${HELP}`);
    }
}
main().catch((error) => {
    log(`오류: ${errorMessage(error)}`);
    process.exitCode = 1;
});
