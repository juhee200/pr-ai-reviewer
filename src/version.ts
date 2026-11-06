import { readFileSync } from 'node:fs';

// src/와 dist/ 어디서 실행하든 한 단계 위의 package.json을 읽는다. 앱 번들 안에서도 같은 구조로 넣는다.
// 실행 중에 다시 읽으면 업그레이드로 바뀐 버전을 알 수 있다. 읽지 못하면 null.
export function readPackageVersion(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function packageVersion(): string {
  return readPackageVersion() ?? '0.0.0';
}

/** 설치된 버전을 읽었고 시작할 때와 다를 때만 true. 파일을 교체하는 중이라 못 읽은 경우는 바뀌지 않은 것으로 본다. */
export function versionChanged(startedVersion: string, installedVersion: string | null): boolean {
  return installedVersion !== null && installedVersion !== startedVersion;
}
