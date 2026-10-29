import { constants, realpathSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ExecError, run } from './exec.ts';

// macOS 로그인 시 자동 실행(launchd LaunchAgent). 사용자 계정 범위라 관리자 권한이 필요 없다.
export const SERVICE_LABEL = 'io.github.juhee200.pr-ai-reviewer.agent';
// v0.2.0까지 쓰던 이름. 등록·해제할 때 함께 정리한다.
const LEGACY_LABELS = ['com.github.juhee200.pr-ai-reviewer'];

function plistPathFor(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

export function plistPath(): string {
  return plistPathFor(SERVICE_LABEL);
}

async function removeLegacyAgents(): Promise<void> {
  for (const label of LEGACY_LABELS) {
    await run('launchctl', ['bootout', `${domain()}/${label}`]);
    await rm(plistPathFor(label), { force: true });
  }
}

export function logPath(): string {
  return join(homedir(), 'Library', 'Logs', 'pr-ai-reviewer', 'agent.log');
}

export interface ServiceSpec {
  nodePath: string;
  scriptPath: string;
  args: string[];
  pathEnv: string;
  logFile: string;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// CLI 파일이 없으면 오류 대신 정상 종료하는 셸 한 줄. 경로는 인자로만 넘기고 셸 문자열에 넣지 않는다.
// 앱이나 npm 패키지를 지운 뒤 로그인했을 때 launchd가 실패한 실행을 30초마다 반복하지 않게 한다.
const SCRIPT_GUARD = '[ -f "$1" ] || exit 0; exec "$0" "$@"';

export function buildPlist(spec: ServiceSpec): string {
  const programArguments = ['/bin/sh', '-c', SCRIPT_GUARD, spec.nodePath, spec.scriptPath, ...spec.args]
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(spec.pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.logFile)}</string>
</dict>
</plist>
`;
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** buildPlist가 만든 plist에서 ProgramArguments를 읽는다. 메뉴바 앱이 어느 CLI로 등록됐는지 확인하는 데 쓴다. */
export function parseProgramArguments(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '';
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1] ?? ''));
}

/** ProgramArguments에서 CLI 파일 경로를 찾는다. 셸 검사를 붙이기 전 형식(node, cli.js, ...)도 읽는다. */
export function scriptPathFromArguments(args: readonly string[]): string | null {
  return (args[0] === '/bin/sh' ? args[4] : args[1]) ?? null;
}

/** 등록된 자동 실행이 이 CLI 파일을 가리킬 때만 plist를 지운다. 이미 다른 CLI로 다시 등록했다면 그대로 둔다. */
export async function removePlistIfScript(scriptPath: string): Promise<boolean> {
  const plist = await readFile(plistPath(), 'utf8').catch(() => '');
  if (scriptPathFromArguments(parseProgramArguments(plist)) !== scriptPath) return false;
  await rm(plistPath(), { force: true });
  return true;
}

/** launchd는 셸의 PATH를 물려받지 않으므로, 쓰는 도구의 디렉터리를 앞에 두고 기본 경로를 뒤에 붙인다. */
export function composePath(toolDirs: readonly string[], currentPath: string): string {
  const entries = [...toolDirs, ...currentPath.split(delimiter), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(entries.filter((entry) => entry.startsWith('/')))].join(delimiter);
}

async function which(command: string, pathEnv: string): Promise<string | null> {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 다음 경로를 본다.
    }
  }
  return null;
}

function domain(): string {
  if (typeof process.getuid !== 'function') throw new Error('사용자 ID를 확인할 수 없습니다.');
  return `gui/${process.getuid()}`;
}

function ensureMacOS(): void {
  if (process.platform !== 'darwin') throw new Error('로그인 시 자동 실행은 macOS에서만 지원합니다.');
}

export async function installService(runArgs: string[], log: (message: string) => void): Promise<void> {
  ensureMacOS();
  const currentPath = process.env['PATH'] ?? '';
  const tools: Record<string, string | null> = {};
  for (const command of ['gh', 'git', 'claude', 'codex']) tools[command] = await which(command, currentPath);
  if (!tools['gh'] || !tools['git']) throw new Error('gh와 git을 PATH에서 찾을 수 없습니다. 설치 후 다시 실행하세요.');
  if (!tools['claude'] && !tools['codex']) log('경고: claude와 codex를 모두 찾지 못했습니다. 리뷰 엔진을 설치하세요.');

  // Homebrew의 Cellar 경로(버전 포함)는 node를 업데이트하면 사라진다. 같은 파일을 가리키는 PATH의 node가 있으면 그 경로를 쓴다.
  const nodeOnPath = await which('node', currentPath);
  const nodePath = nodeOnPath && realpathSync(nodeOnPath) === realpathSync(process.execPath) ? nodeOnPath : process.execPath;
  const toolDirs = [dirname(nodePath), ...Object.values(tools).filter((path): path is string => path !== null).map(dirname)];
  const spec: ServiceSpec = {
    nodePath,
    // 전역 설치 시 bin 심볼릭 링크가 아닌 실제 파일 경로를 쓴다.
    scriptPath: realpathSync(process.argv[1] ?? ''),
    args: runArgs,
    pathEnv: composePath(toolDirs, currentPath),
    logFile: logPath(),
  };

  await mkdir(dirname(plistPath()), { recursive: true });
  await mkdir(dirname(spec.logFile), { recursive: true });
  await writeFile(plistPath(), buildPlist(spec), 'utf8');
  // 이미 등록돼 있으면 내리고 새 설정으로 다시 올린다.
  await removeLegacyAgents();
  await run('launchctl', ['bootout', `${domain()}/${SERVICE_LABEL}`]);
  // bootout 직후에는 이전 작업이 아직 내려가는 중이라 bootstrap이 실패할 수 있어 잠시 재시도한다.
  const bootstrapArgs = ['bootstrap', domain(), plistPath()];
  for (let attempt = 1; ; attempt += 1) {
    const result = await run('launchctl', bootstrapArgs);
    if (result.code === 0) break;
    if (attempt >= 5) throw new ExecError('launchctl', bootstrapArgs, result);
    await sleep(1_000);
  }
  log(`등록했습니다: ${plistPath()}`);
  log(`실행 명령: ${[spec.nodePath, spec.scriptPath, ...spec.args].join(' ')}`);
  log(`로그: ${spec.logFile}`);
}

/**
 * 등록돼 있으면 새 코드로 다시 시작한다. Homebrew로 앱을 업그레이드한 뒤 cask가 부른다.
 * 앱을 지울 때 감시 프로세스가 plist를 지웠다면 launchd에 작업만 남아 있으므로 다시 시작하지 않는다.
 */
export async function restartService(log: (message: string) => void): Promise<void> {
  ensureMacOS();
  const registered = await access(plistPath()).then(() => true, () => false);
  const result = registered ? await run('launchctl', ['kickstart', '-k', `${domain()}/${SERVICE_LABEL}`]) : null;
  log(result?.code === 0 ? '자동 실행을 다시 시작했습니다.' : '자동 실행이 등록돼 있지 않아 다시 시작하지 않았습니다.');
}

export async function uninstallService(log: (message: string) => void): Promise<void> {
  ensureMacOS();
  await removeLegacyAgents();
  await run('launchctl', ['bootout', `${domain()}/${SERVICE_LABEL}`]);
  await rm(plistPath(), { force: true });
  log(`해제했습니다: ${plistPath()}`);
}

export interface ServiceStatus {
  loaded: boolean;
  state: string | null;
  pid: number | null;
  lastExitCode: string | null;
  /** 자동 실행이 쓰는 CLI 파일. 등록되지 않았으면 null. */
  scriptPath: string | null;
}

export function parseLaunchctlPrint(output: string): Omit<ServiceStatus, 'loaded' | 'scriptPath'> {
  const field = (name: string): string | null => output.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1]?.trim() ?? null;
  const pid = field('pid');
  return { state: field('state'), pid: pid === null ? null : Number(pid), lastExitCode: field('last exit code') };
}

export async function serviceStatus(): Promise<ServiceStatus & { logTail: string }> {
  ensureMacOS();
  const printed = await run('launchctl', ['print', `${domain()}/${SERVICE_LABEL}`]);
  let logTail = '';
  try {
    logTail = (await readFile(logPath(), 'utf8')).split('\n').slice(-15).join('\n');
  } catch {
    logTail = '(로그 없음)';
  }
  // plist가 없으면 다음 로그인 때 시작되지 않으므로, launchd에 작업이 남아 있어도 등록되지 않은 것으로 본다.
  const plist = await readFile(plistPath(), 'utf8').catch(() => null);
  if (printed.code !== 0 || plist === null) return { loaded: false, state: null, pid: null, lastExitCode: null, scriptPath: null, logTail };
  const scriptPath = scriptPathFromArguments(parseProgramArguments(plist));
  return { loaded: true, ...parseLaunchctlPrint(printed.stdout), scriptPath, logTail };
}
