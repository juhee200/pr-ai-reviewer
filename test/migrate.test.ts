import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { moveDirectories, pendingMoves } from '../src/migrate.ts';
import { versionChanged } from '../src/version.ts';

describe('옛 이름 폴더 옮기기', () => {
  it('옛 폴더가 있고 새 폴더가 없을 때만 옮기고, 안의 파일을 그대로 둔다', async () => {
    const base = await mkdtemp(join(tmpdir(), 'review-owl-migrate-'));
    try {
      const oldConfig = join(base, 'config', 'pr-ai-reviewer');
      const newConfig = join(base, 'config', 'review-owl');
      const oldState = join(base, 'state', 'pr-ai-reviewer');
      const newState = join(base, 'state', 'review-owl');
      const missing = { from: join(base, 'cache', 'pr-ai-reviewer'), to: join(base, 'cache', 'review-owl') };
      await mkdir(oldConfig, { recursive: true });
      await writeFile(join(oldConfig, 'config.json'), '{"repos":["owner/name"]}');
      await mkdir(oldState, { recursive: true });
      await mkdir(newState, { recursive: true });

      const moves = pendingMoves([{ from: oldConfig, to: newConfig }, { from: oldState, to: newState }, missing]);
      // 새 상태 폴더가 이미 있으면 사용자가 새 버전을 쓰는 중이라 건드리지 않는다. 옛 폴더가 없는 것도 뺀다.
      assert.deepEqual(moves, [{ from: oldConfig, to: newConfig }]);

      const logs: string[] = [];
      await moveDirectories(moves, (message) => logs.push(message));
      assert.equal(existsSync(oldConfig), false);
      assert.equal(await readFile(join(newConfig, 'config.json'), 'utf8'), '{"repos":["owner/name"]}');
      assert.equal(existsSync(oldState), true);
      assert.equal(logs.length, 1);
      assert.deepEqual(pendingMoves(moves), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('versionChanged', () => {
  it('설치된 버전을 읽었고 시작할 때와 다를 때만 다시 시작한다', () => {
    assert.equal(versionChanged('0.5.0', '0.6.0'), true);
    assert.equal(versionChanged('0.6.0', '0.6.0'), false);
    // 업그레이드로 파일을 바꾸는 중이라 package.json을 못 읽으면 기다린다.
    assert.equal(versionChanged('0.6.0', null), false);
  });
});
