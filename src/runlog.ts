import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Severity } from './review/schema.ts';

export interface RunLogEntry {
  at: string;
  repo: string;
  pr: number;
  sha: string;
  engine: string;
  model: string | null;
  dryRun: boolean;
  ok: boolean;
  durationMs: number;
  costUsd: number | null;
  counts?: Record<Severity, number>;
  posted?: boolean;
  outputPath?: string;
  error?: string;
}

/** 리뷰 1건마다 한 줄씩 남긴다. 나중에 심각도별 지적 수와 소요 시간을 집계하는 데 쓴다. */
export async function appendRunLog(stateDir: string, entry: RunLogEntry): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await appendFile(join(stateDir, 'runs.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function saveReviewFile(stateDir: string, repo: string, number: number, sha: string, body: string): Promise<string> {
  const dir = join(stateDir, 'reviews', repo.replace('/', '__'));
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${number}-${sha.slice(0, 7)}-${stamp}.md`);
  await writeFile(path, body, 'utf8');
  return path;
}
