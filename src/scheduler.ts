import type { PullRequest } from './github.ts';
import { prKey, type ReviewMode, type State } from './state.ts';

export type Action = 'review' | 'wait' | 'skip';

export interface Decision {
  pr: PullRequest;
  action: Action;
  reason: string;
}

export interface ScheduleOptions {
  debounceSec: number;
  includeDrafts: boolean;
  maxFailures: number;
  /** 게시 모드면 dry-run으로만 리뷰한 커밋은 아직 처리하지 않은 것으로 본다. */
  postMode: boolean;
}

/**
 * 한 저장소에서 조회한 열린 PR 목록으로 이번 주기에 리뷰할 PR을 정한다.
 * 상태를 직접 바꾸지 않고 갱신된 상태를 새로 돌려준다.
 */
export function schedule(
  repo: string,
  prs: readonly PullRequest[],
  state: State,
  now: Date,
  options: ScheduleOptions,
): { decisions: Decision[]; state: State } {
  const next: State = { version: 1, reviewed: { ...state.reviewed }, pending: { ...state.pending } };
  const decisions: Decision[] = [];
  const openKeys = new Set(prs.map((pr) => prKey(repo, pr.number)));

  for (const pr of prs) {
    const key = prKey(repo, pr.number);
    if (pr.isDraft && !options.includeDrafts) {
      decisions.push({ pr, action: 'skip', reason: 'Draft PR 제외 설정' });
      continue;
    }
    const reviewed = next.reviewed[key];
    if (reviewed?.sha === pr.headSha && (!options.postMode || reviewed.mode === 'post')) {
      delete next.pending[key];
      decisions.push({ pr, action: 'skip', reason: '이미 리뷰한 커밋' });
      continue;
    }

    const pending = next.pending[key];
    if (!pending || pending.sha !== pr.headSha) {
      next.pending[key] = { sha: pr.headSha, firstSeenAt: now.toISOString(), failures: 0 };
      decisions.push(
        options.debounceSec === 0
          ? { pr, action: 'review', reason: '새 커밋' }
          : { pr, action: 'wait', reason: `새 커밋, ${options.debounceSec}초 동안 추가 푸시 대기` },
      );
      continue;
    }
    if (pending.failures >= options.maxFailures) {
      decisions.push({ pr, action: 'skip', reason: `같은 커밋에서 ${pending.failures}회 실패, 새 커밋을 기다림` });
      continue;
    }
    const waitedSec = (now.getTime() - Date.parse(pending.firstSeenAt)) / 1000;
    decisions.push(
      waitedSec >= options.debounceSec
        ? { pr, action: 'review', reason: pending.failures > 0 ? `재시도 ${pending.failures + 1}회차` : '대기 완료' }
        : { pr, action: 'wait', reason: `추가 푸시 대기 중 (${Math.ceil(options.debounceSec - waitedSec)}초 남음)` },
    );
  }

  // 닫히거나 병합된 PR의 대기 항목은 지운다. 리뷰 기록은 다시 열릴 때를 대비해 남긴다.
  for (const key of Object.keys(next.pending)) {
    if (key.startsWith(`${repo}#`) && !openKeys.has(key)) delete next.pending[key];
  }
  return { decisions, state: next };
}

export function markReviewed(
  state: State,
  repo: string,
  number: number,
  sha: string,
  now: Date,
  mode: ReviewMode,
): State {
  const key = prKey(repo, number);
  const pending = { ...state.pending };
  delete pending[key];
  return { version: 1, reviewed: { ...state.reviewed, [key]: { sha, at: now.toISOString(), mode } }, pending };
}

export function markFailed(state: State, repo: string, number: number, sha: string, now: Date): State {
  const key = prKey(repo, number);
  const previous = state.pending[key];
  const failures = previous?.sha === sha ? previous.failures + 1 : 1;
  const firstSeenAt = previous?.sha === sha ? previous.firstSeenAt : now.toISOString();
  return { ...state, pending: { ...state.pending, [key]: { sha, firstSeenAt, failures } } };
}
