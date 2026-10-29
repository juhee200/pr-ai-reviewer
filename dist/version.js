import { readFileSync } from 'node:fs';
// src/와 dist/ 어디서 실행하든 한 단계 위의 package.json을 읽는다. 앱 번들 안에서도 같은 구조로 넣는다.
export function packageVersion() {
    try {
        const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
