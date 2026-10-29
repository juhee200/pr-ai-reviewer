import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePrList, toPullRequest } from '../src/github.ts';

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
