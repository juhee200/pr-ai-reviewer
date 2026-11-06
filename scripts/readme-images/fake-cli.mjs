#!/usr/bin/env node
// README 스크린샷용 가짜 CLI. 앱이 REVIEW_OWL_CLI로 이 파일을 실행하면 실제 gh·claude 대신 샘플 데이터를 돌려준다.
// 실제 계정, 저장소, 경로가 이미지에 찍히지 않게 하려는 용도다.
// 필요한 환경 변수: SAMPLE_STATE_DIR(status.json·runs.jsonl을 둔 폴더), SAMPLE_DAEMON_PID(살아 있는 프로세스 PID)
import { realpathSync } from 'node:fs';

const stateDir = process.env.SAMPLE_STATE_DIR;
const daemonPid = Number(process.env.SAMPLE_DAEMON_PID ?? '0');
if (!stateDir) {
  console.error('[00:00:00] 오류: SAMPLE_STATE_DIR가 없습니다.');
  process.exit(1);
}

const repos = ['acme/order-api', 'acme/web-console'];

const responses = {
  'config show': {
    path: '~/.config/review-owl/config.json',
    exists: true,
    config: {
      repos,
      pollIntervalSec: 60,
      debounceSec: 90,
      includeDrafts: true,
      engine: 'claude',
      model: null,
      dryRun: false,
      stateDir,
    },
  },
  'service status': {
    loaded: true,
    state: 'running',
    pid: daemonPid,
    lastExitCode: null,
    // 앱이 실행한 CLI와 같은 경로여야 "앱 밖의 CLI로 등록" 경고가 뜨지 않는다.
    scriptPath: realpathSync(process.argv[1]),
    plistPath: '~/Library/LaunchAgents/io.github.juhee200.review-owl.agent.plist',
    logPath: '~/Library/Logs/review-owl/agent.log',
  },
  doctor: {
    ready: true,
    checks: [
      { id: 'node', label: 'Node.js 22 이상', ok: true, detail: 'v24.11.0', hint: 'brew install node', required: true },
      { id: 'gh', label: 'GitHub CLI 로그인', ok: true, detail: '로그인됨 (sample-dev)', hint: 'gh auth login', required: true },
      { id: 'git', label: 'git', ok: true, detail: 'git version 2.50.1', hint: 'xcode-select --install', required: true },
      { id: 'claude', label: 'Claude Code', ok: true, detail: '로그인됨 (2.1.0 (Claude Code))', hint: 'claude auth login', required: false },
      {
        id: 'codex',
        label: 'Codex CLI',
        ok: false,
        detail: '설치되지 않음',
        hint: 'brew install codex 후 codex login',
        required: false,
      },
    ],
  },
  repos: [
    { nameWithOwner: 'acme/order-api', isPrivate: true, updatedAt: '2026-11-05T01:10:00Z', selected: true },
    { nameWithOwner: 'acme/web-console', isPrivate: true, updatedAt: '2026-11-05T00:40:00Z', selected: true },
    { nameWithOwner: 'acme/settlement-batch', isPrivate: true, updatedAt: '2026-11-04T08:00:00Z', selected: false },
    { nameWithOwner: 'acme/mobile-app', isPrivate: true, updatedAt: '2026-11-03T05:00:00Z', selected: false },
    { nameWithOwner: 'acme/infra-terraform', isPrivate: true, updatedAt: '2026-11-01T02:00:00Z', selected: false },
    { nameWithOwner: 'sample-dev/dotfiles', isPrivate: false, updatedAt: '2026-10-28T12:00:00Z', selected: false },
  ],
};

const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const key = args.slice(0, 2).join(' ');
const response = responses[key] ?? responses[args[0]];
if (response !== undefined) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
// config set, ctl 등은 아무것도 하지 않고 성공으로 끝낸다.
