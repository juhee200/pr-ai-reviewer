import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { normalizeFindingPath } from './diff.ts';
import type { Finding } from './review/schema.ts';

export interface CodeQuote {
  /** 인용한 첫 줄 번호. */
  startLine: number;
  lines: string[];
  /** 지적 범위가 길어 앞부분만 인용했으면 생략한 줄 수. */
  omittedLines: number;
}

export const MAX_QUOTE_LINES = 15;
const MAX_LINE_LENGTH = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 지적한 코드를 head 커밋 체크아웃에서 읽어 인용한다.
 * 경로는 AI 출력이라 그대로 믿지 않는다. 작업 디렉터리 밖(`..`, 절대 경로, 밖을 가리키는 심볼릭 링크)과 `.git`은 읽지 않는다.
 */
export async function readCodeQuote(rootDir: string, finding: Finding): Promise<CodeQuote | null> {
  if (finding.line === null) return null;
  const file = normalizeFindingPath(finding.file);
  if (file === '' || file.includes('\0') || isAbsolute(file)) return null;

  let target: string;
  let root: string;
  try {
    root = await realpath(rootDir);
    target = await realpath(join(root, file));
  } catch {
    return null;
  }
  const inside = relative(root, target);
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return null;
  if (inside.split(sep)[0] === '.git') return null;

  const info = await stat(target);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
  const buffer = await readFile(target);
  // 바이너리 파일은 인용하지 않는다.
  if (buffer.includes(0)) return null;

  const fileLines = buffer.toString('utf8').split('\n');
  if (fileLines.at(-1) === '') fileLines.pop();
  const start = finding.line;
  if (start > fileLines.length) return null;
  const end = Math.min(finding.endLine ?? start, fileLines.length);
  const shownEnd = Math.min(end, start + MAX_QUOTE_LINES - 1);
  return {
    startLine: start,
    lines: fileLines.slice(start - 1, shownEnd).map(clipLine),
    omittedLines: end - shownEnd,
  };
}

function clipLine(line: string): string {
  const withoutCr = line.endsWith('\r') ? line.slice(0, -1) : line;
  return withoutCr.length > MAX_LINE_LENGTH ? `${withoutCr.slice(0, MAX_LINE_LENGTH)}…` : withoutCr;
}

/** 지적 순서대로 인용을 돌려준다. 읽을 수 없는 지적은 null. */
export async function quoteFindings(rootDir: string, findings: readonly Finding[]): Promise<Array<CodeQuote | null>> {
  return Promise.all(findings.map((finding) => readCodeQuote(rootDir, finding).catch(() => null)));
}
