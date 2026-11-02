import { ExecError, runOk } from './exec.ts';
import { validatePrNumber, validateRepo } from './config.ts';
import { bodyHasMarkerFor } from './marker.ts';
import type { ReviewPost } from './render.ts';

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

/**
 * 다른 PC나 이전 실행에서 같은 커밋을 이미 리뷰해 게시했는지 확인한다.
 * v0.3.x까지는 PR 코멘트로, 이후에는 PR 리뷰 본문으로 게시하므로 둘 다 본다.
 */
export async function hasReviewMarker(repo: string, number: number, sha: string): Promise<boolean> {
  validateRepo(repo);
  const prNumber = validatePrNumber(number);
  const bodies = await Promise.all(
    [`repos/${repo}/issues/${prNumber}/comments`, `repos/${repo}/pulls/${prNumber}/reviews`].map((path) =>
      runOk('gh', ['api', '--paginate', path, '--jq', '.[].body'], { timeoutMs: GH_TIMEOUT_MS }),
    ),
  );
  return bodies.some((text) => bodyHasMarkerFor(text, sha));
}

/**
 * GitHub "Create a review for a pull request" 요청 본문.
 * 작성자는 자기 PR을 승인·변경 요청할 수 없어 event는 COMMENT로 둔다.
 * commitId가 null이면 GitHub가 PR의 최신 커밋에 붙인다.
 */
export function buildReviewPayload(post: ReviewPost, commitId: string | null): Record<string, unknown> {
  return {
    ...(commitId === null ? {} : { commit_id: commitId }),
    event: 'COMMENT',
    body: post.body,
    comments: post.comments.map((comment) => ({
      path: comment.path,
      ...(comment.startLine === null ? {} : { start_line: comment.startLine, start_side: 'RIGHT' }),
      line: comment.line,
      side: 'RIGHT',
      body: comment.body,
    })),
  };
}

/** 리뷰 생성 응답의 html_url. GitHub 주소가 아니면 버린다. */
export function parseReviewUrl(stdout: string): string | null {
  let url: unknown;
  try {
    url = (JSON.parse(stdout) as Record<string, unknown>)['html_url'];
  } catch {
    return null;
  }
  return typeof url === 'string' && /^https:\/\/github\.com\/[^\s]+$/.test(url) ? url : null;
}

/** GitHub가 요청 값(코멘트 줄 위치, 커밋 등)을 받아들이지 않아 리뷰를 만들지 않았는지 판단한다. */
export function isUnprocessableError(error: unknown): boolean {
  return error instanceof ExecError && /\(HTTP 422\)/.test(error.result.stderr);
}

/** PR 리뷰를 게시하고 리뷰의 URL을 돌려준다. */
export async function postReview(repo: string, number: number, post: ReviewPost, commitId: string | null): Promise<string | null> {
  validateRepo(repo);
  // 본문은 인자가 아닌 표준 입력으로 넘긴다.
  const stdout = await runOk(
    'gh',
    ['api', '--method', 'POST', `repos/${repo}/pulls/${validatePrNumber(number)}/reviews`, '--input', '-'],
    { input: JSON.stringify(buildReviewPayload(post, commitId)), timeoutMs: GH_TIMEOUT_MS },
  );
  return parseReviewUrl(stdout);
}
