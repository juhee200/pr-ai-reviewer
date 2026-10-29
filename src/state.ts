import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ReviewedEntry {
  sha: string;
  at: string;
}

export interface PendingEntry {
  sha: string;
  firstSeenAt: string;
  failures: number;
}

export interface State {
  version: 1;
  /** PR별로 마지막으로 리뷰한 커밋. */
  reviewed: Record<string, ReviewedEntry>;
  /** 처음 본 뒤 디바운스를 기다리거나 실패해 재시도할 커밋. */
  pending: Record<string, PendingEntry>;
}

export function emptyState(): State {
  return { version: 1, reviewed: {}, pending: {} };
}

export function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export async function loadState(path: string): Promise<State> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<State>;
  if (parsed.version !== 1) throw new Error(`상태 파일 버전을 알 수 없습니다: ${path}`);
  return { version: 1, reviewed: parsed.reviewed ?? {}, pending: parsed.pending ?? {} };
}

/** 임시 파일에 쓴 뒤 이름을 바꿔, 쓰는 도중 종료돼도 기존 상태 파일이 깨지지 않게 한다. */
export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}
