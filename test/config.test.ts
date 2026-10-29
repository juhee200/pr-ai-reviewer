import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, parseConfig, validateModel, validatePrNumber, validateRepo } from '../src/config.ts';

describe('validateRepo', () => {
  it('owner/name 형식만 받는다', () => {
    assert.equal(validateRepo('acme-corp/order-api'), 'acme-corp/order-api');
    assert.equal(validateRepo('owner/.github'), 'owner/.github');
    for (const bad of ['repo', 'a/b/c', '../etc', 'a/..', 'a/b;rm -rf ~', 'a/b c', '-x/y', 'a/$(id)']) {
      assert.throws(() => validateRepo(bad), new RegExp('형식'), bad);
    }
  });
});

describe('validatePrNumber', () => {
  it('양의 정수만 받는다', () => {
    assert.equal(validatePrNumber('5032'), 5032);
    for (const bad of ['0', '-1', '1.5', 'abc', '1e309', '']) {
      assert.throws(() => validatePrNumber(bad), /PR 번호/, bad);
    }
  });
});

describe('validateModel', () => {
  it('옵션처럼 보이는 값과 허용되지 않은 문자를 거부한다', () => {
    for (const good of ['opus', 'claude-sonnet-5-5', 'gpt-5.5-codex', 'claude-opus-5-5[1m]']) assert.equal(validateModel(good), good);
    for (const bad of ['--dangerously-skip-permissions', '-m', 'a b', 'x;y', '']) assert.throws(() => validateModel(bad), /모델/, bad);
  });
});

describe('parseConfig', () => {
  it('빈 객체면 기본값을 쓴다 (Draft 포함, dry-run 기본)', () => {
    const config = parseConfig({});
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(config.includeDrafts, true);
    assert.equal(config.dryRun, true);
  });

  it('값을 덮어쓰고 중복 저장소를 합친다', () => {
    const config = parseConfig({ repos: ['a/b', 'a/b', 'c/d'], engine: 'codex', debounceSec: 0, maxBudgetUsd: 3 });
    assert.deepEqual(config.repos, ['a/b', 'c/d']);
    assert.equal(config.engine, 'codex');
    assert.equal(config.debounceSec, 0);
    assert.equal(config.maxBudgetUsd, 3);
  });

  it('잘못된 값은 거부한다', () => {
    assert.throws(() => parseConfig([]), /객체/);
    assert.throws(() => parseConfig({ repos: ['bad'] }), /형식/);
    assert.throws(() => parseConfig({ engine: 'gpt' }), /engine/);
    assert.throws(() => parseConfig({ pollIntervalSec: 1 }), /pollIntervalSec/);
    assert.throws(() => parseConfig({ dryRun: 'false' }), /dryRun/);
    assert.throws(() => parseConfig({ maxBudgetUsd: 0 }), /maxBudgetUsd/);
    assert.throws(() => parseConfig({ model: '' }), /model/);
    assert.throws(() => parseConfig({ model: '--help' }), /model/);
    assert.throws(() => parseConfig({ claudeSettingSources: 'project; rm' }), /claudeSettingSources/);
  });
});
