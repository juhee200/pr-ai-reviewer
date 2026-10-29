import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** 리뷰 1건마다 한 줄씩 남긴다. 나중에 심각도별 지적 수와 소요 시간을 집계하는 데 쓴다. */
export async function appendRunLog(stateDir, entry) {
    await mkdir(stateDir, { recursive: true });
    await appendFile(join(stateDir, 'runs.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
}
export async function saveReviewFile(stateDir, repo, number, sha, body) {
    const dir = join(stateDir, 'reviews', repo.replace('/', '__'));
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `${number}-${sha.slice(0, 7)}-${stamp}.md`);
    await writeFile(path, body, 'utf8');
    return path;
}
