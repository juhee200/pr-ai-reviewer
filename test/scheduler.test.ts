import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PullRequest } from '../src/github.ts';
import { markFailed, markReviewed, schedule } from '../src/scheduler.ts';
import { emptyState, prKey } from '../src/state.ts';

const REPO = 'owner/repo';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const OPTIONS = { debounceSec: 90, includeDrafts: true, maxFailures: 3, postMode: false };

function pr(number: number, sha: string, isDraft = false): PullRequest {
  return { repo: REPO, number, title: `PR ${number}`, isDraft, headSha: sha, headRef: 'feature', baseRef: 'develop', url: '', updatedAt: '' };
}

function at(seconds: number): Date {
  return new Date(Date.UTC(2026, 9, 28, 0, 0, seconds));
}

describe('schedule', () => {
  it('새 커밋은 디바운스 동안 기다린 뒤 리뷰한다', () => {
    const first = schedule(REPO, [pr(1, SHA_A)], emptyState(), at(0), OPTIONS);
    assert.equal(first.decisions[0]?.action, 'wait');

    const early = schedule(REPO, [pr(1, SHA_A)], first.state, at(30), OPTIONS);
    assert.equal(early.decisions[0]?.action, 'wait');

    const due = schedule(REPO, [pr(1, SHA_A)], first.state, at(90), OPTIONS);
    assert.equal(due.decisions[0]?.action, 'review');
  });

  it('디바운스가 0이면 바로 리뷰한다', () => {
    const result = schedule(REPO, [pr(1, SHA_A)], emptyState(), at(0), { ...OPTIONS, debounceSec: 0 });
    assert.equal(result.decisions[0]?.action, 'review');
  });

  it('대기 중에 새 커밋이 올라오면 대기 시간을 다시 센다', () => {
    const first = schedule(REPO, [pr(1, SHA_A)], emptyState(), at(0), OPTIONS);
    const pushedAgain = schedule(REPO, [pr(1, SHA_B)], first.state, at(80), OPTIONS);
    assert.equal(pushedAgain.decisions[0]?.action, 'wait');
    const stillWaiting = schedule(REPO, [pr(1, SHA_B)], pushedAgain.state, at(120), OPTIONS);
    assert.equal(stillWaiting.decisions[0]?.action, 'wait');
    const due = schedule(REPO, [pr(1, SHA_B)], pushedAgain.state, at(170), OPTIONS);
    assert.equal(due.decisions[0]?.action, 'review');
  });

  it('이미 리뷰한 커밋은 건너뛰고, 새 커밋이 오면 다시 대기한다', () => {
    const reviewed = markReviewed(emptyState(), REPO, 1, SHA_A, at(0), 'dry-run');
    const same = schedule(REPO, [pr(1, SHA_A)], reviewed, at(10), OPTIONS);
    assert.equal(same.decisions[0]?.action, 'skip');

    const updated = schedule(REPO, [pr(1, SHA_B)], reviewed, at(10), OPTIONS);
    assert.equal(updated.decisions[0]?.action, 'wait');
  });

  it('게시 모드에서는 dry-run으로만 리뷰한 커밋을 다시 처리하고, 게시 모드로 처리한 커밋은 건너뛴다', () => {
    const dryRunReviewed = markReviewed(emptyState(), REPO, 1, SHA_A, at(0), 'dry-run');
    const inPostMode = schedule(REPO, [pr(1, SHA_A)], dryRunReviewed, at(10), { ...OPTIONS, postMode: true });
    assert.equal(inPostMode.decisions[0]?.action, 'wait');

    const posted = markReviewed(emptyState(), REPO, 1, SHA_A, at(0), 'post');
    assert.equal(schedule(REPO, [pr(1, SHA_A)], posted, at(10), { ...OPTIONS, postMode: true }).decisions[0]?.action, 'skip');
    assert.equal(schedule(REPO, [pr(1, SHA_A)], posted, at(10), OPTIONS).decisions[0]?.action, 'skip');
  });

  it('Draft 제외 설정이면 Draft PR을 건너뛰고, 기본 설정이면 리뷰 대상에 넣는다', () => {
    const excluded = schedule(REPO, [pr(1, SHA_A, true)], emptyState(), at(0), { ...OPTIONS, includeDrafts: false });
    assert.equal(excluded.decisions[0]?.action, 'skip');

    const included = schedule(REPO, [pr(1, SHA_A, true)], emptyState(), at(0), { ...OPTIONS, debounceSec: 0 });
    assert.equal(included.decisions[0]?.action, 'review');
  });

  it('같은 커밋에서 최대 실패 횟수에 도달하면 건너뛴다', () => {
    let state = schedule(REPO, [pr(1, SHA_A)], emptyState(), at(0), OPTIONS).state;
    for (let i = 0; i < 3; i += 1) state = markFailed(state, REPO, 1, SHA_A, at(100 + i));
    const result = schedule(REPO, [pr(1, SHA_A)], state, at(500), OPTIONS);
    assert.equal(result.decisions[0]?.action, 'skip');
  });

  it('실패 후에는 디바운스를 다시 기다리지 않고 다음 주기에 재시도한다', () => {
    let state = schedule(REPO, [pr(1, SHA_A)], emptyState(), at(0), OPTIONS).state;
    state = markFailed(state, REPO, 1, SHA_A, at(100));
    const retry = schedule(REPO, [pr(1, SHA_A)], state, at(160), OPTIONS);
    assert.equal(retry.decisions[0]?.action, 'review');
  });

  it('닫힌 PR의 대기 항목은 지우고 다른 저장소 항목은 남긴다', () => {
    const state = emptyState();
    state.pending[prKey(REPO, 1)] = { sha: SHA_A, firstSeenAt: at(0).toISOString(), failures: 0 };
    state.pending[prKey('other/repo', 1)] = { sha: SHA_A, firstSeenAt: at(0).toISOString(), failures: 0 };
    const result = schedule(REPO, [], state, at(10), OPTIONS);
    assert.equal(result.state.pending[prKey(REPO, 1)], undefined);
    assert.ok(result.state.pending[prKey('other/repo', 1)]);
  });

  it('입력 상태 객체를 직접 바꾸지 않는다', () => {
    const state = emptyState();
    schedule(REPO, [pr(1, SHA_A)], state, at(0), OPTIONS);
    assert.deepEqual(state.pending, {});
  });
});
