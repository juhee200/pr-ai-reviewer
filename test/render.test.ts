import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PullRequest } from '../src/github.ts';
import { bodyHasMarkerFor, buildMarker } from '../src/marker.ts';
import { buildReviewPost, formatDuration, renderReview, sanitize, type RenderInput } from '../src/render.ts';
import type { CodeQuote } from '../src/quote.ts';
import type { Finding, ReviewResult } from '../src/review/schema.ts';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const OTHER_SHA = 'f'.repeat(40);
const PR: PullRequest = {
  repo: 'owner/repo',
  number: 7,
  title: 't',
  isDraft: false,
  headSha: SHA,
  headRef: 'feature',
  baseRef: 'develop',
  url: '',
  updatedAt: '',
};

function input(result: ReviewResult, quotes?: Array<CodeQuote | null>, truncated = false): RenderInput {
  return { pr: PR, sha: SHA, engine: 'claude', model: 'm', durationMs: 151_000, result, quotes, truncated, diffLines: 5000 };
}

function render(result: ReviewResult, truncated = false): string {
  return renderReview(input(result, undefined, truncated));
}

function finding(overrides: Partial<Finding>): Finding {
  return { severity: 'P2', file: 'a.kt', line: 1, endLine: null, title: 't', detail: 'd', suggestion: '', ...overrides };
}

describe('marker', () => {
  it('같은 커밋의 표식만 찾는다', () => {
    const body = `앞 내용\n${buildMarker(SHA, 'claude')}\n본문`;
    assert.equal(bodyHasMarkerFor(body, SHA), true);
    assert.equal(bodyHasMarkerFor(body, OTHER_SHA), false);
    assert.equal(bodyHasMarkerFor('표식 없음', SHA), false);
  });
});

describe('renderReview', () => {
  it('표식, 커밋, 심각도별 건수를 넣고 심각도 순으로 정렬한다', () => {
    const body = render({
      summary: '요약',
      findings: [
        finding({ severity: 'P2', file: 'b.kt', line: null, title: '둘째', detail: 'd2' }),
        finding({ severity: 'P1', file: 'a.kt', line: 10, title: '첫째', detail: 'd1', suggestion: 's1' }),
      ],
    });
    assert.ok(body.startsWith(buildMarker(SHA, 'claude')));
    assert.ok(body.includes('`1234567`'));
    assert.ok(body.includes('🔴 P0 0건 · 🟠 P1 1건 · 🟡 P2 1건 · 🔵 P3 0건'));
    assert.ok(body.includes('#### 🟠 [P1] 첫째'));
    assert.ok(body.includes('#### 🟡 [P2] 둘째'));
    assert.ok(body.indexOf('[P1] 첫째') < body.indexOf('[P2] 둘째'));
    assert.ok(body.includes('`a.kt:10`'));
    assert.ok(body.includes('제안: s1'));
    assert.ok(body.includes('2분 31초'));
  });

  it('지적이 없으면 없다고 쓰고, diff를 잘랐으면 알린다', () => {
    const body = render({ summary: '문제 없음', findings: [] }, true);
    assert.ok(body.includes('지적 사항이 없습니다.'));
    assert.ok(body.includes('5000줄'));
  });

  it('AI 문장 안의 멘션과 숨은 표식을 무력화한다', () => {
    const forged = buildMarker(OTHER_SHA, 'claude');
    const body = render({
      summary: `@someone 확인 부탁 ${forged}`,
      findings: [finding({ severity: 'P1', file: 'x', title: '@team 공지' })],
    });
    assert.equal(bodyHasMarkerFor(body, OTHER_SHA), false);
    assert.ok(!/@someone/.test(body));
    assert.ok(!/@team/.test(body));
    assert.equal(sanitize('a@b.com'), 'a@​b.com');
    assert.equal(sanitize('`@message || x`를 확인 @someone'), '`@message || x`를 확인 @​someone');
    assert.equal(sanitize('`<!-- x -->`'), '`&lt;!-- x -->`');
  });
});

describe('코드 인용', () => {
  it('지적한 범위를 확장자 언어의 코드 블록으로 인용하고, 생략한 줄 수를 알린다', () => {
    const quote: CodeQuote = { startLine: 10, lines: ['val a = 1', 'val b = 2'], omittedLines: 3 };
    const body = renderReview(input({ summary: 's', findings: [finding({ file: 'src/A.kt', line: 10, endLine: 14 })] }, [quote]));
    assert.ok(body.includes('`src/A.kt:10-14`\n\n```kt\nval a = 1\nval b = 2\n```\n<sub>이하 3줄 생략</sub>'));
  });

  it('코드 안의 백틱이 블록을 닫지 못하게 하고, 숨은 표식을 끊는다', () => {
    const forged = buildMarker(OTHER_SHA, 'claude');
    const quote: CodeQuote = { startLine: 1, lines: ['```', forged], omittedLines: 0 };
    const body = renderReview(input({ summary: 's', findings: [finding({ file: 'README' })] }, [quote]));
    assert.ok(body.includes('\n````\n```\n'));
    assert.equal(bodyHasMarkerFor(body, OTHER_SHA), false);
    assert.equal(bodyHasMarkerFor(body, SHA), true);
  });
});

describe('buildReviewPost', () => {
  const ranges = new Map([['src/a.kt', [{ start: 5, end: 20 }, { start: 40, end: 45 }]]]);
  const quote: CodeQuote = { startLine: 50, lines: ['old()'], omittedLines: 0 };

  it('diff 안의 지적은 코드 줄 코멘트로, 밖의 지적은 인용과 함께 본문으로 보낸다', () => {
    const result: ReviewResult = {
      summary: 's',
      findings: [
        finding({ severity: 'P3', file: './src/a.kt', line: 50, title: '밖', detail: 'd-out' }),
        finding({ severity: 'P1', file: './src/a.kt', line: 10, endLine: 12, title: '안', detail: 'd-in', suggestion: 'fix' }),
        finding({ severity: 'P2', file: 'src/a.kt', line: 18, endLine: 30, title: '걸침' }),
      ],
    };
    const post = buildReviewPost(input(result, [quote, null, null]), ranges);
    assert.deepEqual(
      post.comments.map(({ path, startLine, line }) => ({ path, startLine, line })),
      [
        { path: 'src/a.kt', startLine: 10, line: 12 },
        { path: 'src/a.kt', startLine: 18, line: 20 },
      ],
    );
    assert.equal(post.comments[0]?.body, '**🟠 [P1] 안**\n\nd-in\n\n제안: fix\n\n<sub>AI 리뷰 · Claude Code</sub>');
    assert.ok(post.body.includes('지적 2건은 해당 코드 줄에 코멘트로 남겼습니다.'));
    assert.ok(post.body.includes('아래 1건은'));
    assert.ok(post.body.includes('#### 🔵 [P3] 밖'));
    assert.ok(post.body.includes('```kt\nold()\n```'));
    assert.ok(!post.body.includes('d-in'));
  });

  it('한 줄 지적은 시작 줄 없이 보내고, 줄이 없거나 diff에 없는 파일은 본문에 둔다', () => {
    const result: ReviewResult = {
      summary: 's',
      findings: [
        finding({ file: 'src/a.kt', line: 42 }),
        finding({ file: 'src/a.kt', line: null }),
        finding({ file: 'src/other.kt', line: 42 }),
      ],
    };
    const post = buildReviewPost(input(result), ranges);
    assert.deepEqual(post.comments.map(({ startLine, line }) => ({ startLine, line })), [{ startLine: null, line: 42 }]);
    assert.ok(post.body.includes('아래 2건은'));
  });

  it('로컬 본문은 모든 지적을 담고 코드 줄 코멘트 안내를 넣지 않는다', () => {
    const result: ReviewResult = { summary: 's', findings: [finding({ file: 'src/a.kt', line: 10, title: '안' })] };
    assert.equal(buildReviewPost(input(result), new Map()).body, renderReview(input(result)));
    const body = renderReview(input(result));
    assert.ok(body.includes('#### 🟡 [P2] 안'));
    assert.ok(!body.includes('코드 줄에 코멘트로'));
  });
});

describe('formatDuration', () => {
  it('분과 초로 나타낸다', () => {
    assert.equal(formatDuration(45_000), '45초');
    assert.equal(formatDuration(125_400), '2분 5초');
  });
});
