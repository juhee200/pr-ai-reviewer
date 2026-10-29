import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSecrets } from '../src/secrets.ts';

describe('findSecrets', () => {
  it('대표적인 비밀값 형식을 찾는다', () => {
    const fakeGithub = `ghp_${'a'.repeat(36)}`;
    const fakeAws = `AKIA${'A'.repeat(16)}`;
    const text = `키 노출 ${fakeAws} 그리고 ${fakeGithub}\n-----BEGIN OPENSSH PRIVATE KEY-----`;
    assert.deepEqual(findSecrets(text).sort(), ['AWS 액세스 키', 'GitHub 토큰', '개인 키'].sort());
    assert.deepEqual(findSecrets(`sk-ant-${'x'.repeat(30)}`), ['API 키(sk-)']);
  });

  it('일반 리뷰 문장과 코드는 걸지 않는다', () => {
    const review = '`app/models/order.rb:85` 에서 `@message || x` 를 확인하세요. SHA 0123456789abcdef0123456789abcdef01234567';
    assert.deepEqual(findSecrets(review), []);
  });
});
