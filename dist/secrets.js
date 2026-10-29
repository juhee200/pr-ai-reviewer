// 게시 직전 리뷰 본문 검사. AI가 조종돼 PC의 비밀값을 읽어 본문에 넣는 경우를 막기 위한 마지막 방어선이다.
const SECRET_PATTERNS = [
    { name: '개인 키', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'AWS 액세스 키', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { name: 'GitHub 토큰', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
    { name: 'Slack 토큰', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/ },
    { name: 'API 키(sk-)', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
    { name: 'Google API 키', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];
/** 찾은 비밀값 종류 이름을 돌려준다. 값 자체는 로그에 남기지 않는다. */
export function findSecrets(text) {
    return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}
