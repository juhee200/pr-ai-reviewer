#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  DEFAULT_CONFIG,
  defaultConfigPath,
  loadConfig,
  mergeConfigPatch,
  parseConfig,
  readRawConfig,
  saveRawConfig,
  validateModel,
  validatePrNumber,
  validateRepo,
  writeDefaultConfig,
  type Config,
  type EngineName,
} from './config.ts';
import { killActiveChildren, run } from './exec.ts';
import { getPr, hasReviewMarker, listMyOpenPrs } from './github.ts';
import { reviewPullRequest } from './reviewer.ts';
import { SEVERITIES, type Severity } from './review/schema.ts';
import { markFailed, markReviewed, schedule, type Action } from './scheduler.ts';
import { runDoctor } from './doctor.ts';
import { listAccessibleRepos } from './repos.ts';
import { looksLikeDaemon, readControl, readStatus, StatusReporter, writeControl, type PendingPr } from './status.ts';
import { packageVersion } from './version.ts';
import {
  installService,
  logPath,
  plistPath,
  removePlistIfScript,
  restartService,
  serviceStatus,
  uninstallService,
} from './service.ts';
import { loadState, saveState } from './state.ts';

const HELP = `pr-ai-reviewer: 내가 올린 PR을 이 PC의 Claude Code 또는 Codex로 리뷰합니다.

사용법
  pr-ai-reviewer init                         설정 파일을 만듭니다
  pr-ai-reviewer review <owner/repo> <번호>   PR 하나를 지금 리뷰합니다
  pr-ai-reviewer run                          내 열린 PR을 감시하며 새 커밋마다 리뷰합니다
  pr-ai-reviewer status                       대기 중인 PR과 리뷰 기록을 보여줍니다
  pr-ai-reviewer service install [--post]     로그인 시 자동 실행으로 등록합니다 (macOS, 옵션은 설정에 저장)
  pr-ai-reviewer service uninstall            자동 실행 등록을 해제합니다
  pr-ai-reviewer service restart              등록된 자동 실행을 다시 시작합니다
  pr-ai-reviewer service status [--json]      자동 실행 상태와 최근 로그를 보여줍니다
  pr-ai-reviewer doctor [--json]              설치·로그인·설정 상태를 점검합니다
  pr-ai-reviewer repos [--json]               선택할 수 있는 저장소 목록을 보여줍니다
  pr-ai-reviewer config show [--json]         설정을 보여줍니다
  pr-ai-reviewer config set                   표준 입력의 JSON으로 설정을 바꿉니다
  pr-ai-reviewer ctl <pause|resume|poll-now>  실행 중인 감시를 일시정지·재개하거나 바로 조회합니다

옵션
  --config <경로>         설정 파일 (기본: ${defaultConfigPath()})
  --engine <claude|codex> 리뷰 엔진 (기본: 설정값)
  --model <이름>          엔진 모델 (기본: 설정값 또는 CLI 기본 모델)
  --dry-run               PR에 게시하지 않고 출력·파일 저장만 합니다
  --post                  PR에 리뷰 코멘트를 게시합니다
  --once                  run: 한 번만 조회하고 끝냅니다
  --plan                  run: 리뷰하지 않고 판정 결과만 보여줍니다
  --sha <커밋>            review: 지정한 커밋 기준으로 리뷰합니다 (평가용)
  --json                  doctor·repos·config show·service status: JSON으로 출력합니다
  -v, --version           버전
  -h, --help              도움말
`;

const ACTION_LABEL: Record<Action, string> = { review: '리뷰 예정', wait: '대기', skip: '건너뜀' };
// 업그레이드 중에는 CLI 파일이 몇 초 동안 없을 수 있어, 이 시간보다 오래 없을 때만 삭제된 것으로 본다.
const SCRIPT_MISSING_GRACE_MS = 120_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function log(message: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  // 로그는 stderr로 보내고, stdout에는 리뷰 본문만 쓴다.
  console.error(`[${time}] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCounts(counts: Record<Severity, number>): string {
  return SEVERITIES.map((severity) => `${severity} ${counts[severity]}`).join(' · ');
}

// 종료 신호를 받으면 실행 중인 AI·git 프로세스를 멈추고 worktree를 정리한 뒤 끝낸다.
const controller = new AbortController();
let interrupted = false;
function onSignal(signal: NodeJS.Signals): void {
  if (interrupted) process.exit(130);
  interrupted = true;
  log(`${signal} 수신: 실행 중인 작업을 정리하고 종료합니다. 한 번 더 누르면 즉시 종료합니다.`);
  controller.abort();
  killActiveChildren();
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

interface CliValues {
  config?: string | undefined;
  engine?: string | undefined;
  model?: string | undefined;
  'dry-run'?: boolean | undefined;
  post?: boolean | undefined;
  once?: boolean | undefined;
  plan?: boolean | undefined;
  sha?: string | undefined;
  json?: boolean | undefined;
  version?: boolean | undefined;
  help?: boolean | undefined;
}

function resolveDryRun(values: CliValues, config: Config): boolean {
  if (values.post && values['dry-run']) throw new Error('--post와 --dry-run은 함께 쓸 수 없습니다.');
  if (values.post) return false;
  if (values['dry-run']) return true;
  return config.dryRun;
}

function resolveEngine(values: CliValues, config: Config): EngineName {
  if (values.engine === undefined) return config.engine;
  if (values.engine !== 'claude' && values.engine !== 'codex') throw new Error('--engine은 claude 또는 codex여야 합니다.');
  return values.engine;
}

function resolveModel(values: CliValues, config: Config): string | null {
  return values.model === undefined ? config.model : validateModel(values.model);
}

function ensureReposConfigured(config: Config, configPath: string): void {
  if (config.repos.length === 0 || config.repos.includes('owner/name')) {
    throw new Error(`설정 파일의 repos에 감시할 저장소를 넣으세요: ${configPath}`);
  }
}

async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, 'run.lock');
  try {
    await writeFile(path, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number((await readFile(path, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      throw new Error(`이미 실행 중입니다 (PID ${pid}). 잠금 파일: ${path}`);
    }
    // 비정상 종료로 남은 잠금 파일이다.
    await writeFile(path, String(process.pid));
  }
  return () => rm(path, { force: true });
}

// 잠금 파일의 PID를 다른 프로그램이 재사용했을 수 있어, 신호를 보내기 전에 명령줄로 감시 프로세스인지 확인한다.
async function isDaemonProcess(pid: number): Promise<boolean> {
  const result = await run('ps', ['-o', 'command=', '-p', String(pid)]);
  return result.code === 0 && looksLikeDaemon(result.stdout);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function commandInit(configPath: string): Promise<void> {
  const created = await writeDefaultConfig(configPath);
  console.log(
    created
      ? `설정 파일을 만들었습니다: ${configPath}\nrepos를 감시할 저장소(owner/name)로 바꾼 뒤 run을 실행하세요.`
      : `설정 파일이 이미 있습니다: ${configPath}`,
  );
}

async function commandReview(config: Config, values: CliValues, args: string[]): Promise<void> {
  const [repoArg, numberArg] = args;
  if (repoArg === undefined || numberArg === undefined) throw new Error('사용법: pr-ai-reviewer review <owner/repo> <번호>');
  const repo = validateRepo(repoArg);
  const number = validatePrNumber(numberArg);
  if (values.sha !== undefined && !SHA_PATTERN.test(values.sha)) throw new Error('--sha는 40자리 커밋 SHA여야 합니다.');

  const dryRun = resolveDryRun(values, config);
  const pr = await getPr(repo, number);
  const outcome = await reviewPullRequest(
    config,
    { pr, sha: values.sha, engine: resolveEngine(values, config), model: resolveModel(values, config), dryRun },
    log,
  );
  process.stdout.write(`${outcome.body}\n`);
  log(`결과: ${formatCounts(outcome.counts)} · 저장 ${outcome.outputPath}`);
  if (outcome.posted) log('PR에 게시했습니다.');
  else log(dryRun ? 'dry-run이라 PR에 게시하지 않았습니다.' : `게시하지 않음: ${outcome.skippedReason ?? ''}`);
}

interface PollSummary {
  pending: PendingPr[];
  lastError: string | null;
}

async function pollOnce(config: Config, values: CliValues, statePath: string, reporter: StatusReporter | null): Promise<PollSummary> {
  const dryRun = resolveDryRun(values, config);
  const engine = resolveEngine(values, config);
  const model = resolveModel(values, config);
  let state = await loadState(statePath);
  const pending: PendingPr[] = [];
  let lastError: string | null = null;

  for (const repo of config.repos) {
    if (controller.signal.aborted) break;
    let prs;
    try {
      prs = await listMyOpenPrs(repo);
    } catch (error) {
      lastError = `${repo} PR 조회 실패: ${errorMessage(error)}`;
      log(lastError);
      continue;
    }
    const scheduled = schedule(repo, prs, state, new Date(), { ...config, postMode: !dryRun });
    if (values.plan) {
      if (scheduled.decisions.length === 0) log(`${repo}: 내 열린 PR 없음`);
      for (const { pr, action, reason } of scheduled.decisions) {
        log(`${repo}#${pr.number}${pr.isDraft ? ' (Draft)' : ''} ${ACTION_LABEL[action]}: ${reason} · ${pr.title}`);
      }
      // --plan은 조회만 하고 상태를 바꾸지 않는다.
      continue;
    }
    state = scheduled.state;

    for (const { pr, action, reason } of scheduled.decisions) {
      if (action === 'wait') {
        log(`${repo}#${pr.number} ${ACTION_LABEL[action]}: ${reason}`);
        pending.push({ repo, pr: pr.number, title: pr.title, isDraft: pr.isDraft, url: pr.url, reason });
      }
      if (action !== 'review') continue;
      if (controller.signal.aborted) break;

      await reporter?.update({
        phase: 'reviewing',
        current: { repo, pr: pr.number, title: pr.title, sha: pr.headSha, startedAt: new Date().toISOString() },
      });
      try {
        if (!dryRun && (await hasReviewMarker(repo, pr.number, pr.headSha))) {
          log(`${repo}#${pr.number}: 같은 커밋의 리뷰가 이미 PR에 있어 건너뜁니다.`);
          state = markReviewed(state, repo, pr.number, pr.headSha, new Date(), 'post');
        } else {
          const outcome = await reviewPullRequest(config, { pr, engine, model, dryRun }, log);
          state = markReviewed(state, repo, pr.number, pr.headSha, new Date(), dryRun ? 'dry-run' : 'post');
          log(
            `${repo}#${pr.number} 리뷰 완료: ${formatCounts(outcome.counts)} · ` +
              `${outcome.posted ? `PR에 게시 ${outcome.commentUrl ?? ''}` : 'dry-run 저장'} ${outcome.outputPath}`,
          );
          if (dryRun) process.stdout.write(`${outcome.body}\n`);
        }
      } catch (error) {
        state = markFailed(state, repo, pr.number, pr.headSha, new Date());
        lastError = `${repo}#${pr.number} 리뷰 실패: ${errorMessage(error)}`;
        log(lastError);
      }
      await reporter?.update({ phase: 'polling', current: null });
      await saveState(statePath, state);
    }
    await saveState(statePath, state);
  }
  return { pending, lastError };
}

async function commandRun(initialConfig: Config, values: CliValues, configPath: string): Promise<void> {
  ensureReposConfigured(initialConfig, configPath);
  let config = initialConfig;
  // 잠금·상태 파일 위치는 실행 중에 바꾸지 않는다.
  const { stateDir } = initialConfig;
  const statePath = join(stateDir, 'state.json');
  // --plan은 다른 프로세스의 상태 표시를 덮어쓰지 않도록 상태 파일을 쓰지 않는다.
  const reporter = values.plan
    ? null
    : new StatusReporter(stateDir, {
        appVersion: packageVersion(),
        mode: resolveDryRun(values, config) ? 'dry-run' : 'post',
        engine: resolveEngine(values, config),
        repos: config.repos,
        phase: 'starting',
        current: null,
        pending: [],
        lastPollAt: null,
        nextPollAt: null,
        lastError: null,
      });

  // SIGUSR2: 메뉴바 앱의 '지금 조회'·'일시정지/재개'가 대기를 깨운다.
  // SIGUSR1은 Node가 디버거를 켜는 신호로 예약해 두었으므로 쓰지 않는다.
  // 처리기가 없을 때 SIGUSR2의 기본 동작은 종료라서, 잠금 파일에 PID를 쓰기 전에 등록한다.
  let wake = new AbortController();
  const onWake = (): void => wake.abort();
  process.on('SIGUSR2', onWake);
  let release: () => Promise<void>;
  try {
    release = await acquireLock(stateDir);
  } catch (error) {
    process.off('SIGUSR2', onWake);
    throw error;
  }
  const waitForNextPoll = async (ms: number): Promise<void> => {
    try {
      await sleep(ms, undefined, { signal: AbortSignal.any([controller.signal, wake.signal]) });
    } catch {
      // 깨우기나 종료 신호로 대기가 끝났다.
    } finally {
      if (wake.signal.aborted) wake = new AbortController();
    }
  };

  // 앱이나 npm 패키지를 지우면 실행 중인 CLI 파일이 사라진다. 2분 넘게 없으면 자동 실행 등록(plist)을 지우고
  // 정상 종료한다. KeepAlive는 정상 종료면 재시작하지 않으므로, 지운 앱이 계속 리뷰하지 않는다.
  const scriptPath = (() => {
    try {
      return realpathSync(process.argv[1] ?? '');
    } catch {
      return null;
    }
  })();
  let scriptMissingSince: number | null = null;
  const scriptRemoved = async (): Promise<boolean> => {
    if (scriptPath === null || existsSync(scriptPath)) {
      scriptMissingSince = null;
      return false;
    }
    scriptMissingSince ??= Date.now();
    if (Date.now() - scriptMissingSince < SCRIPT_MISSING_GRACE_MS) return false;
    const removed = process.platform === 'darwin' && (await removePlistIfScript(scriptPath).catch(() => false));
    log(`실행 파일이 사라졌습니다: ${scriptPath}. ${removed ? '자동 실행 등록을 지우고 ' : ''}종료합니다.`);
    return true;
  };

  // 메뉴바 앱에서 바꾼 설정을 재시작 없이 적용하려고 조회 주기마다 설정 파일을 다시 읽는다.
  // 진행 중인 리뷰는 시작할 때의 설정으로 끝낸다. 읽기에 실패하면 이전 설정으로 계속한다.
  const reloadConfig = async (): Promise<string | null> => {
    try {
      const next: Config = { ...(await loadConfig(configPath)), stateDir };
      if (JSON.stringify(next) !== JSON.stringify(config)) log('바뀐 설정을 적용합니다.');
      config = next;
      return null;
    } catch (error) {
      const message = `설정을 다시 읽지 못해 이전 설정으로 계속합니다: ${errorMessage(error)}`;
      log(message);
      return message;
    }
  };

  try {
    const mode = values.plan ? '판정만' : resolveDryRun(values, config) ? 'dry-run' : 'PR 게시';
    log(`감시 시작: ${config.repos.join(', ')} · ${config.pollIntervalSec}초 간격 · ${mode} · 엔진 ${resolveEngine(values, config)}`);
    await reporter?.update({});
    while (!controller.signal.aborted) {
      if (await scriptRemoved()) break;
      const configError = await reloadConfig();
      await reporter?.update({
        mode: resolveDryRun(values, config) ? 'dry-run' : 'post',
        engine: resolveEngine(values, config),
        repos: config.repos,
      });
      const control = await readControl(stateDir);
      if (control.paused && !values.once && !values.plan) {
        await reporter?.update({ phase: 'paused', nextPollAt: null, current: null, lastError: configError });
        await waitForNextPoll(config.pollIntervalSec * 1000);
        continue;
      }
      await reporter?.update({ phase: 'polling', current: null });
      const startedAt = new Date();
      const summary = await pollOnce(config, values, statePath, reporter);
      await reporter?.update({ pending: summary.pending, lastError: summary.lastError ?? configError });
      if (values.once || values.plan) break;
      const nextPollAt = new Date(Date.now() + config.pollIntervalSec * 1000);
      await reporter?.update({ phase: 'waiting', lastPollAt: startedAt.toISOString(), nextPollAt: nextPollAt.toISOString(), current: null });
      await waitForNextPoll(config.pollIntervalSec * 1000);
    }
  } finally {
    process.off('SIGUSR2', onWake);
    await reporter?.update({ phase: 'stopped', nextPollAt: null, current: null });
    await release();
  }
}

async function commandStatus(config: Config): Promise<void> {
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

async function commandDoctor(values: CliValues, configPath: string): Promise<void> {
  const result = await runDoctor(configPath);
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const check of result.checks) {
    console.log(`${check.ok ? '✓' : check.required ? '✗' : '-'} ${check.label}: ${check.detail}${!check.ok && check.hint ? ` → ${check.hint}` : ''}`);
  }
  console.log(result.ready ? '\n시작할 준비가 됐습니다.' : '\n✗ 표시를 먼저 해결하세요.');
}

async function commandRepos(values: CliValues, configPath: string): Promise<void> {
  const repos = await listAccessibleRepos();
  const configuredRepos = (await readRawConfig(configPath).catch(() => null))?.['repos'];
  const configured = new Set(Array.isArray(configuredRepos) ? configuredRepos : []);
  const items = repos.map((repo) => ({ ...repo, selected: configured.has(repo.nameWithOwner) }));
  if (values.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  for (const item of items) console.log(`${item.selected ? '[x]' : '[ ]'} ${item.nameWithOwner}${item.isPrivate ? ' (비공개)' : ''}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function commandConfig(values: CliValues, args: string[], configPath: string): Promise<void> {
  const [action] = args;
  if (action === 'show') {
    const raw = await readRawConfig(configPath);
    const config = raw ? parseConfig(raw) : DEFAULT_CONFIG;
    const output = { path: resolve(configPath), exists: raw !== null, config };
    console.log(values.json ? JSON.stringify(output, null, 2) : `${output.path}\n${JSON.stringify(config, null, 2)}`);
    return;
  }
  if (action === 'set') {
    // 변경값은 표준 입력의 JSON으로 받는다. 예: echo '{"engine":"codex"}' | pr-ai-reviewer config set
    let patch: unknown;
    try {
      patch = JSON.parse(await readStdin());
    } catch {
      throw new Error('표준 입력이 올바른 JSON이 아닙니다.');
    }
    const { raw } = mergeConfigPatch(await readRawConfig(configPath), patch);
    await saveRawConfig(configPath, raw);
    log(`설정을 저장했습니다: ${resolve(configPath)}`);
    return;
  }
  throw new Error('사용법: pr-ai-reviewer config <show|set>');
}

async function commandCtl(args: string[], configPath: string): Promise<void> {
  const [action] = args;
  const raw = await readRawConfig(configPath).catch(() => null);
  const stateDir = raw ? parseConfig(raw).stateDir : DEFAULT_CONFIG.stateDir;
  if (action === 'pause' || action === 'resume') await writeControl(stateDir, { paused: action === 'pause' });
  else if (action !== 'poll-now') throw new Error('사용법: pr-ai-reviewer ctl <pause|resume|poll-now>');

  const pid = Number((await readFile(join(stateDir, 'run.lock'), 'utf8').catch(() => '')).trim());
  // v0.2.0 이하 감시 프로세스는 SIGUSR2 처리기가 없어 신호를 받으면 종료된다.
  // 상태 파일을 쓰는 버전(처리기가 있는 버전)이 같은 PID로 실행 중일 때만 신호를 보낸다.
  const status = await readStatus(stateDir);
  const signalable = status !== null && status.pid === pid && status.phase !== 'stopped';
  if (Number.isInteger(pid) && pid > 0 && signalable && isAlive(pid) && (await isDaemonProcess(pid))) {
    process.kill(pid, 'SIGUSR2');
    log(`감시 프로세스(PID ${pid})에 알렸습니다: ${action}`);
  } else {
    log(action === 'poll-now' ? '알릴 수 있는 감시 프로세스가 없습니다.' : `저장했습니다(${action}). 감시 프로세스가 다음 조회 때 적용합니다.`);
  }
}

async function commandService(values: CliValues, args: string[], configPath: string): Promise<void> {
  const [action] = args;
  if (action === 'install') {
    // --post·--engine·--model은 설정 파일에 저장하고, 자동 실행 명령에는 설정 파일 경로만 넣는다.
    // 메뉴바 앱과 CLI가 같은 설정 파일 하나를 기준으로 동작하게 하기 위해서다.
    const absoluteConfigPath = resolve(configPath);
    if (values.post && values['dry-run']) throw new Error('--post와 --dry-run은 함께 쓸 수 없습니다.');
    const patch: Record<string, unknown> = {};
    if (values.post) patch['dryRun'] = false;
    if (values['dry-run']) patch['dryRun'] = true;
    if (values.engine !== undefined) patch['engine'] = values.engine;
    if (values.model !== undefined) patch['model'] = values.model;
    const merged = mergeConfigPatch(await readRawConfig(absoluteConfigPath), patch);
    // 등록 전에 설정을 검증해, 잘못된 설정으로 자동 실행이 재시작을 반복하지 않게 한다.
    ensureReposConfigured(merged.config, absoluteConfigPath);
    if (Object.keys(patch).length > 0) await saveRawConfig(absoluteConfigPath, merged.raw);
    await installService(['run', '--config', absoluteConfigPath], log);
    log(merged.config.dryRun ? 'dry-run 모드로 등록했습니다. PR에 게시하지 않습니다.' : 'PR 게시 모드로 등록했습니다.');
    return;
  }
  if (action === 'uninstall') return uninstallService(log);
  if (action === 'restart') return restartService(log);
  if (action === 'status') {
    const status = await serviceStatus();
    if (values.json) {
      const { loaded, state, pid, lastExitCode, scriptPath } = status;
      console.log(JSON.stringify({ loaded, state, pid, lastExitCode, scriptPath, plistPath: plistPath(), logPath: logPath() }, null, 2));
      return;
    }
    console.log(status.loaded ? `등록됨 · 상태 ${status.state ?? '알 수 없음'}${status.pid ? ` · PID ${status.pid}` : ''} · 마지막 종료 코드 ${status.lastExitCode ?? '-'}` : '등록되지 않음');
    console.log(`최근 로그\n${status.logTail}`);
    return;
  }
  throw new Error('사용법: pr-ai-reviewer service <install|uninstall|restart|status>');
}

async function main(): Promise<void> {
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
      json: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.version) {
    console.log(packageVersion());
    return;
  }
  if (values.help || command === undefined || command === 'help') {
    console.log(HELP);
    return;
  }

  const configPath = values.config ?? defaultConfigPath();
  if (command === 'init') return commandInit(configPath);
  if (command === 'service') return commandService(values, args, configPath);
  if (command === 'doctor') return commandDoctor(values, configPath);
  if (command === 'repos') return commandRepos(values, configPath);
  if (command === 'config') return commandConfig(values, args, configPath);
  if (command === 'ctl') return commandCtl(args, configPath);

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

main().catch((error: unknown) => {
  log(`오류: ${errorMessage(error)}`);
  process.exitCode = 1;
});
