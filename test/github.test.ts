import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExecError } from '../src/exec.ts';
import { buildReviewPayload, isUnprocessableError, parsePrList, parseReviewUrl, toPullRequest } from '../src/github.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 5032,
    title: 'feature(TICKET-1) : 테스트',
    isDraft: true,
    headRefOid: SHA,
    headRefName: 'feature/TICKET-1',
    baseRefName: 'develop',
    url: 'https://github.com/owner/repo/pull/5032',
    updatedAt: '2026-10-28T00:00:00Z',
    ...overrides,
  };
}

describe('toPullRequest', () => {
  it('gh 응답을 PullRequest로 바꾼다', () => {
    const pr = toPullRequest('owner/repo', raw());
    assert.equal(pr.number, 5032);
    assert.equal(pr.isDraft, true);
    assert.equal(pr.headSha, SHA);
    assert.equal(pr.baseRef, 'develop');
  });

  it('git 인자로 쓰일 값의 형식이 이상하면 거부한다', () => {
    assert.throws(() => toPullRequest('owner/repo', raw({ headRefOid: 'abc' })), /SHA/);
    assert.throws(() => toPullRequest('owner/repo', raw({ headRefOid: `${SHA}; rm` })), /SHA/);
    assert.throws(() => toPullRequest('owner/repo', raw({ baseRefName: '--upload-pack=x' })), /base/);
    assert.throws(() => toPullRequest('owner/repo', raw({ baseRefName: 'a..b' })), /base/);
    for (const bad of ['dev:main', 'a b', 'x~1', 'x^', 'a*', 'a[b', 'a\\b', 'a\nb']) {
      assert.throws(() => toPullRequest('owner/repo', raw({ baseRefName: bad })), /base/, bad);
    }
    assert.equal(toPullRequest('owner/repo', raw({ baseRefName: 'release/2026.10' })).baseRef, 'release/2026.10');
    assert.throws(() => toPullRequest('owner/repo', raw({ number: -1 })), /PR 번호/);
  });
});

describe('parsePrList', () => {
  it('배열 응답만 받는다', () => {
    assert.equal(parsePrList('owner/repo', JSON.stringify([raw(), raw({ number: 1 })])).length, 2);
    assert.throws(() => parsePrList('owner/repo', '{}'), /배열/);
  });
});

describe('PR 리뷰 게시', () => {
  it('코드 줄 코멘트를 head 쪽 줄로 보내고, 여러 줄이면 시작 줄을 함께 보낸다', () => {
    const payload = buildReviewPayload(
      {
        body: '본문',
        comments: [
          { path: 'a.kt', startLine: null, line: 3, body: 'c1' },
          { path: 'b.kt', startLine: 10, line: 12, body: 'c2' },
        ],
      },
      SHA,
    );
    assert.deepEqual(payload, {
      commit_id: SHA,
      event: 'COMMENT',
      body: '본문',
      comments: [
        { path: 'a.kt', line: 3, side: 'RIGHT', body: 'c1' },
        { path: 'b.kt', start_line: 10, start_side: 'RIGHT', line: 12, side: 'RIGHT', body: 'c2' },
      ],
    });
    assert.ok(!('commit_id' in buildReviewPayload({ body: 'b', comments: [] }, null)));
  });

  it('응답의 html_url이 GitHub 주소일 때만 받는다', () => {
    const url = 'https://github.com/o/r/pull/1#pullrequestreview-1';
    assert.equal(parseReviewUrl(JSON.stringify({ id: 1, html_url: url })), url);
    assert.equal(parseReviewUrl(JSON.stringify({ html_url: 'https://evil.example.com/x' })), null);
    assert.equal(parseReviewUrl('not json'), null);
  });

  it('HTTP 422 실패만 다시 게시할 대상으로 본다', () => {
    const failed = (stderr: string): ExecError => new ExecError('gh', ['api'], { code: 1, stdout: '', stderr, timedOut: false });
    assert.equal(isUnprocessableError(failed('gh: Unprocessable Entity (HTTP 422)')), true);
    assert.equal(isUnprocessableError(failed('gh: Not Found (HTTP 404)')), false);
    assert.equal(isUnprocessableError(new Error('(HTTP 422)')), false);
  });
});
