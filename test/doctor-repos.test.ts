import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isReady, nodeVersionOk, type Check } from '../src/doctor.ts';
import { parseCommentUrl } from '../src/github.ts';
import { mergeRepoLists, parseRepoList } from '../src/repos.ts';

describe('doctor', () => {
  it('Node 주 버전을 비교한다', () => {
    assert.equal(nodeVersionOk('v26.4.0'), true);
    assert.equal(nodeVersionOk('v22.0.0'), true);
    assert.equal(nodeVersionOk('v20.11.1'), false);
    assert.equal(nodeVersionOk('abc'), false);
  });

  it('필수 항목이 모두 통과해야 준비 완료로 본다', () => {
    const check = (id: string, ok: boolean, required: boolean): Check => ({ id, label: id, ok, detail: '', hint: null, required });
    assert.equal(isReady([check('node', true, true), check('codex', false, false)]), true);
    assert.equal(isReady([check('node', true, true), check('gh', false, true)]), false);
  });
});

describe('repos', () => {
  it('형식이 이상한 저장소를 빼고, 중복 제거 후 최근 갱신순으로 정렬한다', () => {
    const a = parseRepoList(JSON.stringify([
      { nameWithOwner: 'me/old', isPrivate: false, updatedAt: '2026-01-01T00:00:00Z' },
      { nameWithOwner: 'bad name', isPrivate: false, updatedAt: '2026-12-01T00:00:00Z' },
    ]));
    const b = parseRepoList(JSON.stringify([
      { nameWithOwner: 'org/new', isPrivate: true, updatedAt: '2026-10-01T00:00:00Z' },
      { nameWithOwner: 'me/old', isPrivate: false, updatedAt: '2026-01-01T00:00:00Z' },
    ]));
    assert.deepEqual(mergeRepoLists([a, b]).map((repo) => repo.nameWithOwner), ['org/new', 'me/old']);
    assert.deepEqual(parseRepoList('{}'), []);
  });
});

describe('parseCommentUrl', () => {
  it('gh 출력의 마지막 줄이 GitHub 주소일 때만 받는다', () => {
    assert.equal(parseCommentUrl('https://github.com/o/r/pull/1#issuecomment-1\n'), 'https://github.com/o/r/pull/1#issuecomment-1');
    assert.equal(parseCommentUrl('done'), null);
    assert.equal(parseCommentUrl('https://evil.example.com/x'), null);
  });
});
