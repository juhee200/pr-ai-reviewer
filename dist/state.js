import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export function emptyState() {
    return { version: 1, reviewed: {}, pending: {} };
}
export function prKey(repo, number) {
    return `${repo}#${number}`;
}
export async function loadState(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return emptyState();
        throw error;
    }
    const parsed = JSON.parse(text);
    if (parsed.version !== 1)
        throw new Error(`상태 파일 버전을 알 수 없습니다: ${path}`);
    return { version: 1, reviewed: parsed.reviewed ?? {}, pending: parsed.pending ?? {} };
}
/** 임시 파일에 쓴 뒤 이름을 바꿔, 쓰는 도중 종료돼도 기존 상태 파일이 깨지지 않게 한다. */
export async function saveState(path, state) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, path);
}
