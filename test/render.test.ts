import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PullRequest } from '../src/github.ts';
import { bodyHasMarkerFor, buildMarker } from '../src/marker.ts';
import { formatDuration, renderReview, sanitize } from '../src/render.ts';
import type { ReviewResult } from '../src/review/schema.ts';

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

function render(result: ReviewResult, truncated = false): string {
  return renderReview({ pr: PR, sha: SHA, engine: 'claude', model: 'm', durationMs: 151_000, result, truncated, diffLines: 5000 });
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
        { severity: 'P2', file: 'b.kt', line: null, title: '둘째', detail: 'd2', suggestion: '' },
        { severity: 'P1', file: 'a.kt', line: 10, title: '첫째', detail: 'd1', suggestion: 's1' },
      ],
    });
    assert.ok(body.startsWith(buildMarker(SHA, 'claude')));
    assert.ok(body.includes('`1234567`'));
    assert.ok(body.includes('P0 0건 · P1 1건 · P2 1건 · P3 0건'));
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
      findings: [{ severity: 'P1', file: 'x', line: 1, title: '@team 공지', detail: 'd', suggestion: '' }],
    });
    assert.equal(bodyHasMarkerFor(body, OTHER_SHA), false);
    assert.ok(!/@someone/.test(body));
    assert.ok(!/@team/.test(body));
    assert.equal(sanitize('a@b.com'), 'a@​b.com');
    assert.equal(sanitize('`@message || x`를 확인 @someone'), '`@message || x`를 확인 @​someone');
    assert.equal(sanitize('`<!-- x -->`'), '`&lt;!-- x -->`');
  });
});

describe('formatDuration', () => {
  it('분과 초로 나타낸다', () => {
    assert.equal(formatDuration(45_000), '45초');
    assert.equal(formatDuration(125_400), '2분 5초');
  });
});
