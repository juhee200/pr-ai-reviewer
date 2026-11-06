import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { APP_SLUG, LEGACY_SLUG, XDG_CACHE, XDG_CONFIG, XDG_STATE } from './config.ts';
import { logDir, removeLegacyAgents } from './service.ts';

export interface DirectoryMove {
  from: string;
  to: string;
}

/** v0.5.0까지 pr-ai-reviewer 이름으로 쓰던 설정·상태·캐시·로그 폴더와 옮길 위치. */
export function legacyDirectoryMoves(): DirectoryMove[] {
  const moves: DirectoryMove[] = [];
  // 환경 변수로 설정 파일 위치를 정했다면 그 파일이 옛 폴더 안에 있을 수 있어 설정 폴더는 옮기지 않는다.
  if (!process.env['REVIEW_OWL_CONFIG'] && !process.env['PR_AI_REVIEWER_CONFIG']) {
    moves.push({ from: join(XDG_CONFIG, LEGACY_SLUG), to: join(XDG_CONFIG, APP_SLUG) });
  }
  moves.push(
    { from: join(XDG_STATE, LEGACY_SLUG), to: join(XDG_STATE, APP_SLUG) },
    { from: join(XDG_CACHE, LEGACY_SLUG), to: join(XDG_CACHE, APP_SLUG) },
  );
  if (process.platform === 'darwin') moves.push({ from: logDir(LEGACY_SLUG), to: logDir(APP_SLUG) });
  return moves;
}

/** 옛 폴더가 있고 새 폴더가 없는 것만 고른다. 새 폴더가 이미 있으면 사용자가 새 버전을 쓰기 시작한 것이므로 건드리지 않는다. */
export function pendingMoves(moves: readonly DirectoryMove[]): DirectoryMove[] {
  return moves.filter((move) => existsSync(move.from) && !existsSync(move.to));
}

/** 같은 디스크 안에서 이름만 바꾸므로 캐시가 커도 바로 끝난다. */
export async function moveDirectories(moves: readonly DirectoryMove[], log: (message: string) => void): Promise<void> {
  for (const move of moves) {
    await mkdir(dirname(move.to), { recursive: true });
    await rename(move.from, move.to);
    log(`이름 변경에 맞춰 폴더를 옮겼습니다: ${move.from} → ${move.to}`);
  }
}

/**
 * pr-ai-reviewer에서 리뷰엉이(review-owl)로 이름을 바꾼 뒤 처음 실행할 때 한 번 옮긴다.
 * 옛 감시 프로세스가 옛 폴더에 계속 쓰지 않게, 옮기기 전에 옛 자동 실행을 먼저 내린다.
 * 자동 실행은 새 이름으로 다시 등록해야 한다(설정 창의 자동 리뷰 또는 service install).
 */
export async function migrateFromLegacyName(log: (message: string) => void): Promise<void> {
  const moves = pendingMoves(legacyDirectoryMoves());
  if (moves.length === 0) return;
  if (process.platform === 'darwin') await removeLegacyAgents();
  await moveDirectories(moves, log);
}
