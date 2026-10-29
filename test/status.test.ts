import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { looksLikeDaemon, readControl, readStatus, StatusReporter, statusPath, writeControl } from '../src/status.ts';

describe('status·control', () => {
  it('상태를 갱신할 때마다 파일에 쓰고 다시 읽을 수 있다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prr-status-'));
    try {
      const reporter = new StatusReporter(dir, {
        appVersion: '0.3.0', mode: 'post', engine: 'claude', repos: ['o/r'], phase: 'starting',
        current: null, pending: [], lastPollAt: null, nextPollAt: null, lastError: null,
      });
      await reporter.update({ phase: 'reviewing', current: { repo: 'o/r', pr: 1, title: 't', sha: 'a'.repeat(40), startedAt: 'x' } });
      const status = await readStatus(dir);
      assert.equal(status?.phase, 'reviewing');
      assert.equal(status?.current?.pr, 1);
      assert.equal(status?.pid, process.pid);
      assert.ok((await readFile(statusPath(dir), 'utf8')).endsWith('\n'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('제어 파일이 없으면 일시정지가 아니고, 저장한 값을 읽는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prr-control-'));
    try {
      assert.deepEqual(await readControl(dir), { paused: false });
      await writeControl(dir, { paused: true });
      assert.deepEqual(await readControl(dir), { paused: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('감시 프로세스 명령줄만 신호 대상으로 본다', () => {
    assert.equal(looksLikeDaemon('/opt/homebrew/bin/node /x/pr-ai-reviewer/dist/cli.js run --post --config /c.json'), true);
    assert.equal(looksLikeDaemon('node src/cli.ts run --once'), true);
    assert.equal(looksLikeDaemon('/usr/bin/vim notes.txt'), false);
    assert.equal(looksLikeDaemon('/x/pr-ai-reviewer/dist/cli.js doctor'), false);
  });
});
