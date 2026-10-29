import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** ps 명령줄이 pr-ai-reviewer 감시 프로세스(run)인지 판단한다. */
export function looksLikeDaemon(commandLine) {
    return /pr-ai-reviewer|cli\.(?:js|ts)/.test(commandLine) && /\brun\b/.test(commandLine);
}
export function statusPath(stateDir) {
    return join(stateDir, 'status.json');
}
export function controlPath(stateDir) {
    return join(stateDir, 'control.json');
}
async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, path);
}
export async function readControl(stateDir) {
    try {
        const parsed = JSON.parse(await readFile(controlPath(stateDir), 'utf8'));
        return { paused: parsed.paused === true };
    }
    catch {
        return { paused: false };
    }
}
export async function writeControl(stateDir, control) {
    await writeJsonAtomic(controlPath(stateDir), control);
}
export async function readStatus(stateDir) {
    try {
        return JSON.parse(await readFile(statusPath(stateDir), 'utf8'));
    }
    catch {
        return null;
    }
}
/** 상태를 메모리에 들고 있다가 바뀔 때마다 파일에 쓴다. 쓰기 실패는 감시를 멈추지 않는다. */
export class StatusReporter {
    stateDir;
    status;
    constructor(stateDir, initial) {
        this.stateDir = stateDir;
        this.status = { version: 1, pid: process.pid, updatedAt: new Date().toISOString(), ...initial };
    }
    get snapshot() {
        return this.status;
    }
    async update(patch) {
        this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
        try {
            await writeJsonAtomic(statusPath(this.stateDir), this.status);
        }
        catch {
            // 상태 파일은 표시용이므로 실패해도 리뷰는 계속한다.
        }
    }
}
