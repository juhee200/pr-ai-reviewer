import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// 메뉴바 앱이 읽는 감시 프로세스 상태. 앱은 이 파일과 runs.jsonl만 읽고 감시 프로세스와 직접 통신하지 않는다.
export type Phase = 'starting' | 'polling' | 'reviewing' | 'waiting' | 'paused' | 'stopped';

export interface CurrentReview {
  repo: string;
  pr: number;
  title: string;
  sha: string;
  startedAt: string;
}

export interface PendingPr {
  repo: string;
  pr: number;
  title: string;
  isDraft: boolean;
  url: string;
  reason: string;
}

export interface DaemonStatus {
  version: 1;
  pid: number;
  appVersion: string;
  mode: 'dry-run' | 'post';
  engine: string;
  repos: string[];
  phase: Phase;
  current: CurrentReview | null;
  pending: PendingPr[];
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface Control {
  paused: boolean;
}

/** ps 명령줄이 pr-ai-reviewer 감시 프로세스(run)인지 판단한다. */
export function looksLikeDaemon(commandLine: string): boolean {
  return /pr-ai-reviewer|cli\.(?:js|ts)/.test(commandLine) && /\brun\b/.test(commandLine);
}

export function statusPath(stateDir: string): string {
  return join(stateDir, 'status.json');
}

export function controlPath(stateDir: string): string {
  return join(stateDir, 'control.json');
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

export async function readControl(stateDir: string): Promise<Control> {
  try {
    const parsed = JSON.parse(await readFile(controlPath(stateDir), 'utf8')) as Partial<Control>;
    return { paused: parsed.paused === true };
  } catch {
    return { paused: false };
  }
}

export async function writeControl(stateDir: string, control: Control): Promise<void> {
  await writeJsonAtomic(controlPath(stateDir), control);
}

export async function readStatus(stateDir: string): Promise<DaemonStatus | null> {
  try {
    return JSON.parse(await readFile(statusPath(stateDir), 'utf8')) as DaemonStatus;
  } catch {
    return null;
  }
}

/** 상태를 메모리에 들고 있다가 바뀔 때마다 파일에 쓴다. 쓰기 실패는 감시를 멈추지 않는다. */
export class StatusReporter {
  private readonly stateDir: string;
  private status: DaemonStatus;

  constructor(stateDir: string, initial: Omit<DaemonStatus, 'version' | 'pid' | 'updatedAt'>) {
    this.stateDir = stateDir;
    this.status = { version: 1, pid: process.pid, updatedAt: new Date().toISOString(), ...initial };
  }

  get snapshot(): DaemonStatus {
    return this.status;
  }

  async update(patch: Partial<Omit<DaemonStatus, 'version' | 'pid'>>): Promise<void> {
    this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
    try {
      await writeJsonAtomic(statusPath(this.stateDir), this.status);
    } catch {
      // 상태 파일은 표시용이므로 실패해도 리뷰는 계속한다.
    }
  }
}
