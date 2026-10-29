import { runOk } from './exec.ts';
import { validatePrNumber, validateRepo } from './config.ts';
import { bodyHasMarkerFor } from './marker.ts';

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  isDraft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  url: string;
  updatedAt: string;
}

const PR_FIELDS = 'number,title,isDraft,headRefOid,headRefName,baseRefName,url,updatedAt';
const GH_TIMEOUT_MS = 60_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** gh 응답 한 건을 검증해 PullRequest로 바꾼다. 형식이 다르면 이후 git·경로에 쓰이지 않도록 바로 실패시킨다. */
export function toPullRequest(repo: string, raw: unknown): PullRequest {
  if (raw === null || typeof raw !== 'object') throw new Error('gh PR 응답 형식이 올바르지 않습니다.');
  const item = raw as Record<string, unknown>;
  const headSha = String(item['headRefOid'] ?? '');
  if (!SHA_PATTERN.test(headSha)) throw new Error(`PR head 커밋 SHA 형식이 올바르지 않습니다: ${headSha}`);
  const baseRef = String(item['baseRefName'] ?? '');
  // git 참조 이름에 쓸 수 없는 문자와 옵션처럼 보이는 값을 거부한다.
  if (baseRef === '' || baseRef.startsWith('-') || baseRef.includes('..') || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(baseRef)) {
    throw new Error(`PR base 브랜치 이름이 올바르지 않습니다: ${baseRef}`);
  }
  return {
    repo,
    number: validatePrNumber(item['number'] as number),
    title: String(item['title'] ?? ''),
    isDraft: item['isDraft'] === true,
    headSha,
    headRef: String(item['headRefName'] ?? ''),
    baseRef,
    url: String(item['url'] ?? ''),
    updatedAt: String(item['updatedAt'] ?? ''),
  };
}

export function parsePrList(repo: string, json: string): PullRequest[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('gh pr list 응답이 배열이 아닙니다.');
  return parsed.map((item) => toPullRequest(repo, item));
}

export async function listMyOpenPrs(repo: string): Promise<PullRequest[]> {
  validateRepo(repo);
  const stdout = await runOk(
    'gh',
    ['pr', 'list', '--repo', repo, '--author', '@me', '--state', 'open', '--json', PR_FIELDS, '--limit', '100'],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  return parsePrList(repo, stdout);
}

export async function getPr(repo: string, number: number): Promise<PullRequest> {
  validateRepo(repo);
  const stdout = await runOk('gh', ['pr', 'view', String(validatePrNumber(number)), '--repo', repo, '--json', PR_FIELDS], {
    timeoutMs: GH_TIMEOUT_MS,
  });
  return toPullRequest(repo, JSON.parse(stdout));
}

/** 다른 PC나 이전 실행에서 같은 커밋을 이미 리뷰해 게시했는지 확인한다. */
export async function hasReviewMarker(repo: string, number: number, sha: string): Promise<boolean> {
  validateRepo(repo);
  const stdout = await runOk(
    'gh',
    ['api', '--paginate', `repos/${repo}/issues/${validatePrNumber(number)}/comments`, '--jq', '.[].body'],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  return bodyHasMarkerFor(stdout, sha);
}

export async function postComment(repo: string, number: number, body: string): Promise<void> {
  validateRepo(repo);
  // 본문은 인자가 아닌 표준 입력으로 넘긴다.
  await runOk('gh', ['pr', 'comment', String(validatePrNumber(number)), '--repo', repo, '--body-file', '-'], {
    input: body,
    timeoutMs: GH_TIMEOUT_MS,
  });
}
