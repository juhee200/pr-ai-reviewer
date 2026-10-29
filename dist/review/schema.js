export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
/**
 * Claude `--json-schema`와 Codex `--output-schema`에 함께 넘기는 스키마.
 * Codex(OpenAI structured outputs)는 모든 속성이 required이고 additionalProperties가 false여야 한다.
 */
export const REVIEW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'findings'],
    properties: {
        summary: { type: 'string' },
        findings: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['severity', 'file', 'line', 'title', 'detail', 'suggestion'],
                properties: {
                    severity: { type: 'string', enum: [...SEVERITIES] },
                    file: { type: 'string' },
                    line: { type: ['integer', 'null'] },
                    title: { type: 'string' },
                    detail: { type: 'string' },
                    suggestion: { type: 'string' },
                },
            },
        },
    },
};
/** 엔진 출력은 외부 데이터로 보고 다시 검증한다. */
export function parseReviewResult(raw) {
    if (raw === null || typeof raw !== 'object')
        throw new Error('리뷰 결과가 객체가 아닙니다.');
    const value = raw;
    if (typeof value['summary'] !== 'string')
        throw new Error('리뷰 결과에 summary가 없습니다.');
    if (!Array.isArray(value['findings']))
        throw new Error('리뷰 결과에 findings 배열이 없습니다.');
    const findings = value['findings'].map((item, index) => {
        if (item === null || typeof item !== 'object')
            throw new Error(`findings[${index}]가 객체가 아닙니다.`);
        const finding = item;
        const severity = finding['severity'];
        if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
            throw new Error(`findings[${index}].severity 값이 올바르지 않습니다: ${String(severity)}`);
        }
        const line = finding['line'];
        return {
            severity: severity,
            file: requireString(finding, 'file', index),
            line: typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null,
            title: requireString(finding, 'title', index),
            detail: requireString(finding, 'detail', index),
            suggestion: typeof finding['suggestion'] === 'string' ? finding['suggestion'] : '',
        };
    });
    return { summary: value['summary'], findings };
}
function requireString(item, key, index) {
    const value = item[key];
    if (typeof value !== 'string')
        throw new Error(`findings[${index}].${key}가 문자열이 아닙니다.`);
    return value;
}
export function countBySeverity(findings) {
    const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const finding of findings)
        counts[finding.severity] += 1;
    return counts;
}
