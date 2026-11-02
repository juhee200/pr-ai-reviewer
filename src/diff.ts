export interface LineRange {
  start: number;
  end: number;
}

/**
 * diff에서 head 커밋 쪽 줄 범위를 파일별로 모은다.
 * GitHub는 PR diff의 hunk에 나오는 줄(추가·문맥 줄)에만 코드 줄 코멘트를 달 수 있어, 코멘트를 달 위치를 고르는 데 쓴다.
 * `git diff --src-prefix=a/ --dst-prefix=b/` 출력을 전제로 한다.
 */
export function parseDiffLineRanges(diff: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  let file: string | null = null;
  let inHeader = false;
  for (const line of diff.split('\n')) {
    // hunk 본문 줄은 ' ', '+', '-', '\'로 시작하므로 'diff --git'과 '@@'로 시작하는 줄은 항상 머리 줄이다.
    if (line.startsWith('diff --git ')) {
      file = null;
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith('+++ ')) {
      file = parseNewPath(line.slice(4));
      continue;
    }
    if (!line.startsWith('@@ ')) continue;
    inHeader = false;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (file === null || match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;
    const list = ranges.get(file) ?? [];
    list.push({ start, end: start + count - 1 });
    ranges.set(file, list);
  }
  return ranges;
}

function parseNewPath(raw: string): string | null {
  // git은 공백이 든 경로 뒤에 탭을 붙인다. 따옴표로 감싼(제어 문자가 든) 경로와 삭제된 파일은 코멘트 대상에서 뺀다.
  const path = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (!path.startsWith('b/')) return null;
  return path.slice(2);
}

/**
 * 지적 위치를 코멘트를 달 수 있는 범위로 맞춘다. 한 코멘트의 시작·끝 줄은 같은 hunk 안에 있어야 하므로,
 * 지적 범위와 처음 겹치는 hunk와의 교집합을 쓴다. 겹치는 hunk가 없으면 null.
 */
export function findCommentRange(
  ranges: ReadonlyMap<string, readonly LineRange[]>,
  file: string,
  line: number | null,
  endLine: number | null,
): LineRange | null {
  if (line === null) return null;
  const end = endLine ?? line;
  for (const hunk of ranges.get(normalizeFindingPath(file)) ?? []) {
    const start = Math.max(line, hunk.start);
    const last = Math.min(end, hunk.end);
    if (start <= last) return { start, end: last };
  }
  return null;
}

/** AI가 `./src/a.kt`처럼 쓴 경로를 diff의 경로 형식에 맞춘다. */
export function normalizeFindingPath(file: string): string {
  return file.replace(/^(?:\.\/)+/, '');
}
