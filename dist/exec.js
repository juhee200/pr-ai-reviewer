import { spawn } from 'node:child_process';
const DEFAULT_MAX_OUTPUT = 50 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
// 종료 신호를 받았을 때 실행 중인 자식 프로세스를 함께 정리하기 위한 목록.
const activeChildren = new Set();
export function killActiveChildren() {
    for (const child of activeChildren)
        child.kill('SIGTERM');
}
export class ExecError extends Error {
    command;
    result;
    constructor(command, args, result) {
        // 인자에는 프롬프트가 들어갈 수 있어 메시지에는 앞부분만 남긴다.
        const shownArgs = args.slice(0, 4).join(' ');
        const reason = result.timedOut ? '시간 초과' : `종료 코드 ${result.code}`;
        super(`${command} ${shownArgs} 실패 (${reason}): ${tail(result.stderr, 800)}`);
        this.name = 'ExecError';
        this.command = command;
        this.result = result;
    }
}
/** 셸을 거치지 않고 실행한다. 인자 안의 `;`, `$()` 같은 문자는 그대로 문자열로 전달된다. */
export function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        activeChildren.add(child);
        const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = options.timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
            }, options.timeoutMs)
            : undefined;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            if (stdout.length + chunk.length > maxOutput) {
                child.kill('SIGTERM');
                return;
            }
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < STDERR_LIMIT)
                stderr += chunk;
        });
        // 자식이 입력을 다 읽기 전에 끝나면 EPIPE가 날 수 있어 무시한다. 결과는 종료 코드로 판단한다.
        child.stdin.on('error', () => { });
        child.on('error', (error) => {
            if (timer)
                clearTimeout(timer);
            activeChildren.delete(child);
            reject(error);
        });
        child.on('close', (code) => {
            if (timer)
                clearTimeout(timer);
            activeChildren.delete(child);
            resolve({ code: code ?? -1, stdout, stderr, timedOut });
        });
        child.stdin.end(options.input ?? '');
    });
}
/** 종료 코드가 0이 아니거나 시간 초과면 ExecError를 던지고, 성공하면 표준 출력을 돌려준다. */
export async function runOk(command, args, options = {}) {
    const result = await run(command, args, options);
    if (result.code !== 0 || result.timedOut)
        throw new ExecError(command, args, result);
    return result.stdout;
}
function tail(text, max) {
    const trimmed = text.trim();
    return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}
