import { loadConfig } from './config.ts';
import { run } from './exec.ts';
import { serviceStatus } from './service.ts';

// 온보딩 화면의 환경 점검. 개인정보(이메일, 조직명)는 결과에 넣지 않는다.
export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  hint: string | null;
  /** false면 없어도 시작할 수 있다(예: 쓰지 않는 엔진). */
  required: boolean;
}

export interface DoctorResult {
  checks: Check[];
  ready: boolean;
}

export function nodeVersionOk(version: string, minMajor = 22): boolean {
  const match = /^v?(\d+)\./.exec(version);
  return match !== null && Number(match[1]) >= minMajor;
}

export function isReady(checks: readonly Check[]): boolean {
  return checks.filter((check) => check.required).every((check) => check.ok);
}

async function probe(command: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const result = await run(command, args, { timeoutMs: 20_000 });
    return { ok: result.code === 0 && !result.timedOut, out: (result.stdout || result.stderr).trim() };
  } catch {
    // 명령이 없으면(ENOENT) 여기로 온다.
    return { ok: false, out: '' };
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

export async function runDoctor(configPath: string): Promise<DoctorResult> {
  const checks: Check[] = [];

  checks.push({
    id: 'node',
    label: 'Node.js 22 이상',
    ok: nodeVersionOk(process.version),
    detail: process.version,
    hint: 'brew install node',
    required: true,
  });

  const gh = await probe('gh', ['--version']);
  const ghLogin = gh.ok ? await probe('gh', ['api', 'user', '--jq', '.login']) : { ok: false, out: '' };
  checks.push({
    id: 'gh',
    label: 'GitHub CLI 로그인',
    ok: gh.ok && ghLogin.ok,
    detail: !gh.ok ? '설치되지 않음' : ghLogin.ok ? `로그인됨 (${firstLine(ghLogin.out)})` : '로그인 필요',
    hint: !gh.ok ? 'brew install gh 후 gh auth login' : 'gh auth login',
    required: true,
  });

  const git = await probe('git', ['--version']);
  checks.push({ id: 'git', label: 'git', ok: git.ok, detail: git.ok ? firstLine(git.out) : '설치되지 않음', hint: 'xcode-select --install', required: true });

  const claude = await probe('claude', ['--version']);
  let claudeLoggedIn = false;
  if (claude.ok) {
    const status = await probe('claude', ['auth', 'status', '--json']);
    try {
      claudeLoggedIn = status.ok && (JSON.parse(status.out) as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      claudeLoggedIn = false;
    }
  }
  checks.push({
    id: 'claude',
    label: 'Claude Code',
    ok: claude.ok && claudeLoggedIn,
    detail: !claude.ok ? '설치되지 않음' : claudeLoggedIn ? `로그인됨 (${firstLine(claude.out)})` : '로그인 필요',
    hint: !claude.ok ? 'https://claude.com/claude-code 에서 설치 후 claude auth login' : 'claude auth login',
    required: false,
  });

  const codex = await probe('codex', ['--version']);
  const codexLogin = codex.ok ? await probe('codex', ['login', 'status']) : { ok: false, out: '' };
  checks.push({
    id: 'codex',
    label: 'Codex CLI',
    ok: codex.ok && codexLogin.ok,
    detail: !codex.ok ? '설치되지 않음' : codexLogin.ok ? `로그인됨 (${firstLine(codex.out)})` : '로그인 필요',
    hint: !codex.ok ? 'brew install codex 후 codex login' : 'codex login',
    required: false,
  });

  let engine: 'claude' | 'codex' = 'claude';
  try {
    const config = await loadConfig(configPath);
    engine = config.engine;
    const reposOk = config.repos.length > 0 && !config.repos.includes('owner/name');
    checks.push({
      id: 'config',
      label: '설정',
      ok: reposOk,
      detail: reposOk
        ? `저장소 ${config.repos.length}개 · 엔진 ${config.engine} · ${config.dryRun ? 'dry-run' : '실제 게시'}`
        : '감시할 저장소를 선택하세요',
      hint: null,
      required: true,
    });
  } catch (error) {
    checks.push({ id: 'config', label: '설정', ok: false, detail: firstLine(error instanceof Error ? error.message : String(error)), hint: null, required: true });
  }

  const engineCheck = checks.find((check) => check.id === engine);
  checks.push({
    id: 'engine',
    label: `리뷰 엔진 (${engine})`,
    ok: engineCheck?.ok === true,
    detail: engineCheck?.ok ? '사용 가능' : `${engine}을(를) 아직 쓸 수 없음`,
    hint: engineCheck?.hint ?? null,
    required: true,
  });

  if (process.platform === 'darwin') {
    const service = await serviceStatus();
    checks.push({
      id: 'service',
      label: '로그인 시 자동 실행',
      ok: service.loaded && service.state === 'running',
      detail: service.loaded ? `상태 ${service.state ?? '알 수 없음'}` : '등록되지 않음',
      hint: null,
      required: false,
    });
  }

  return { checks, ready: isReady(checks) };
}
