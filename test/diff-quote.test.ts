import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findCommentRange, parseDiffLineRanges } from '../src/diff.ts';
import { MAX_QUOTE_LINES, readCodeQuote } from '../src/quote.ts';
import type { Finding } from '../src/review/schema.ts';

const DIFF = [
  'diff --git a/src/A.kt b/src/A.kt',
  'index 1111111..2222222 100644',
  '--- a/src/A.kt',
  '+++ b/src/A.kt',
  '@@ -1,3 +1,4 @@ class A',
  ' a',
  '+++b',
  '+c',
  ' d',
  '@@ -20,2 +21 @@ fun x()',
  '-old',
  ' keep',
  'diff --git a/with space.kt b/with space.kt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/with space.kt\t',
  '@@ -0,0 +1,2 @@',
  '+x',
  '+y',
  'diff --git a/gone.kt b/gone.kt',
  'deleted file mode 100644',
  '--- a/gone.kt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  '-y',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/"tab\\there.kt" b/"tab\\there.kt"',
  '--- "a/tab\\there.kt"',
  '+++ "b/tab\\there.kt"',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n');

describe('parseDiffLineRanges', () => {
  it('파일별 head 쪽 hunk 범위를 모으고, 삭제·바이너리·따옴표 경로는 뺀다', () => {
    const ranges = parseDiffLineRanges(DIFF);
    assert.deepEqual([...ranges.keys()], ['src/A.kt', 'with space.kt']);
    assert.deepEqual(ranges.get('src/A.kt'), [
      { start: 1, end: 4 },
      { start: 21, end: 21 },
    ]);
    assert.deepEqual(ranges.get('with space.kt'), [{ start: 1, end: 2 }]);
  });

  it('hunk 안의 "+++"로 시작하는 추가 줄을 파일 머리로 읽지 않는다', () => {
    assert.ok(!parseDiffLineRanges(DIFF).has('b'));
  });
});

describe('findCommentRange', () => {
  const ranges = parseDiffLineRanges(DIFF);
  it('지적 범위를 처음 겹치는 hunk 안으로 줄인다', () => {
    assert.deepEqual(findCommentRange(ranges, 'src/A.kt', 2, 3), { start: 2, end: 3 });
    assert.deepEqual(findCommentRange(ranges, './src/A.kt', 3, 30), { start: 3, end: 4 });
    assert.deepEqual(findCommentRange(ranges, 'src/A.kt', 15, 22), { start: 21, end: 21 });
    assert.equal(findCommentRange(ranges, 'src/A.kt', 10, null), null);
    assert.equal(findCommentRange(ranges, 'src/A.kt', null, null), null);
    assert.equal(findCommentRange(ranges, 'gone.kt', 1, null), null);
  });
});

describe('readCodeQuote', () => {
  const finding = (file: string, line: number | null, endLine: number | null = null): Finding => ({
    severity: 'P1',
    file,
    line,
    endLine,
    title: 't',
    detail: 'd',
    suggestion: '',
  });

  async function withRepo(run: (root: string, outside: string) => Promise<void>): Promise<void> {
    const base = await mkdtemp(join(tmpdir(), 'review-owl-quote-'));
    try {
      const root = join(base, 'repo');
      const outside = join(base, 'secret.txt');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'A.kt'), Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join('\r\n') + '\r\n');
      await writeFile(join(root, '.git'), 'gitdir: /somewhere/else\n');
      await writeFile(join(root, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
      await writeFile(outside, 'TOKEN=very-secret\n');
      await symlink(outside, join(root, 'link.txt'));
      await symlink(join(root, 'src', 'A.kt'), join(root, 'inner-link.kt'));
      await run(root, outside);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  it('지적한 줄 범위를 읽고, 길면 앞부분만 남긴다', async () => {
    await withRepo(async (root) => {
      assert.deepEqual(await readCodeQuote(root, finding('./src/A.kt', 2, 3)), { startLine: 2, lines: ['line2', 'line3'], omittedLines: 0 });
      const long = await readCodeQuote(root, finding('src/A.kt', 1, 30));
      assert.equal(long?.lines.length, MAX_QUOTE_LINES);
      assert.equal(long?.omittedLines, 30 - MAX_QUOTE_LINES);
      assert.deepEqual((await readCodeQuote(root, finding('src/A.kt', 40, 99)))?.lines, ['line40']);
      assert.equal(await readCodeQuote(root, finding('src/A.kt', 41)), null);
      assert.equal(await readCodeQuote(root, finding('src/A.kt', null)), null);
      assert.deepEqual((await readCodeQuote(root, finding('inner-link.kt', 1)))?.lines, ['line1']);
    });
  });

  it('작업 디렉터리 밖, .git, 바이너리, 없는 파일은 읽지 않는다', async () => {
    await withRepo(async (root, outside) => {
      for (const file of ['../secret.txt', 'src/../../secret.txt', outside, 'link.txt', '.git', 'bin.dat', 'none.kt', '', 'src']) {
        assert.equal(await readCodeQuote(root, finding(file, 1)), null, file);
      }
    });
  });
});
