import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countBySeverity, parseReviewResult, REVIEW_SCHEMA } from '../src/review/schema.ts';

describe('parseReviewResult', () => {
  it('정상 결과를 받고 줄 번호가 이상하면 null로 바꾼다', () => {
    const result = parseReviewResult({
      summary: 's',
      findings: [
        { severity: 'P1', file: 'a', line: 3, title: 't', detail: 'd', suggestion: 'x' },
        { severity: 'P3', file: 'b', line: -1, title: 't', detail: 'd', suggestion: 'x' },
        { severity: 'P2', file: 'c', line: 1.5, title: 't', detail: 'd', suggestion: 'x' },
      ],
    });
    assert.deepEqual(result.findings.map((finding) => finding.line), [3, null, null]);
    assert.deepEqual(countBySeverity(result.findings), { P0: 0, P1: 1, P2: 1, P3: 1 });
  });

  it('형식이 다르면 실패한다', () => {
    assert.throws(() => parseReviewResult(null), /객체/);
    assert.throws(() => parseReviewResult({ findings: [] }), /summary/);
    assert.throws(() => parseReviewResult({ summary: 's' }), /findings/);
    assert.throws(
      () => parseReviewResult({ summary: 's', findings: [{ severity: 'HIGH', file: 'a', line: 1, title: 't', detail: 'd', suggestion: '' }] }),
      /severity/,
    );
    assert.throws(
      () => parseReviewResult({ summary: 's', findings: [{ severity: 'P1', file: 1, line: 1, title: 't', detail: 'd', suggestion: '' }] }),
      /file/,
    );
  });
});

describe('REVIEW_SCHEMA', () => {
  it('Codex structured output 조건을 지킨다: 모든 속성 required, additionalProperties false', () => {
    const check = (schema: Record<string, unknown>): void => {
      if (schema['type'] === 'object') {
        const properties = Object.keys(schema['properties'] as object);
        assert.deepEqual([...(schema['required'] as string[])].sort(), properties.sort());
        assert.equal(schema['additionalProperties'], false);
        for (const child of Object.values(schema['properties'] as Record<string, Record<string, unknown>>)) check(child);
      }
      if (schema['type'] === 'array') check(schema['items'] as Record<string, unknown>);
    };
    check(REVIEW_SCHEMA as unknown as Record<string, unknown>);
  });
});
