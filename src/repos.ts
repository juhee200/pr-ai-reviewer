import { validateRepo } from './config.ts';
import { runOk } from './exec.ts';

// 온보딩 화면의 저장소 선택 목록. gh로 내 계정과 소속 조직의 저장소를 모은다.
export interface RepoInfo {
  nameWithOwner: string;
  isPrivate: boolean;
  updatedAt: string;
}

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function parseRepoList(json: string): RepoInfo[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const repos: RepoInfo[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const name = String(value['nameWithOwner'] ?? '');
    try {
      validateRepo(name);
    } catch {
      continue;
    }
    repos.push({ nameWithOwner: name, isPrivate: value['isPrivate'] === true, updatedAt: String(value['updatedAt'] ?? '') });
  }
  return repos;
}

/** 중복을 없애고 최근에 갱신된 저장소부터 정렬한다. */
export function mergeRepoLists(lists: readonly RepoInfo[][]): RepoInfo[] {
  const byName = new Map<string, RepoInfo>();
  for (const repo of lists.flat()) byName.set(repo.nameWithOwner, repo);
  return [...byName.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listAccessibleRepos(): Promise<RepoInfo[]> {
  const me = (await runOk('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 30_000 })).trim();
  const orgs = (await runOk('gh', ['api', '--paginate', 'user/orgs', '--jq', '.[].login'], { timeoutMs: 30_000 }))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => OWNER_PATTERN.test(line));
  const owners = [...new Set([me, ...orgs])].filter((owner) => OWNER_PATTERN.test(owner));

  const lists = await Promise.all(
    owners.map(async (owner) => {
      try {
        const out = await runOk(
          'gh',
          ['repo', 'list', owner, '--limit', '300', '--no-archived', '--json', 'nameWithOwner,isPrivate,updatedAt'],
          { timeoutMs: 60_000 },
        );
        return parseRepoList(out);
      } catch {
        // 권한이 없는 조직은 건너뛴다.
        return [];
      }
    }),
  );
  return mergeRepoLists(lists);
}
