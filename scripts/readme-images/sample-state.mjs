#!/usr/bin/env node
// README 스크린샷용 감시 상태(status.json)와 실행 기록(runs.jsonl)을 만든다.
// 사용법: node sample-state.mjs <stateDir> <살아 있는 프로세스 PID>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [stateDir, pidText] = process.argv.slice(2);
if (!stateDir || !pidText) {
  console.error('사용법: node sample-state.mjs <stateDir> <pid>');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const sha = (seed) => seed.repeat(40).slice(0, 40);

mkdirSync(join(stateDir, 'reviews', 'acme__order-api'), { recursive: true });
const savedReview = join(stateDir, 'reviews', 'acme__order-api', '405-c0ffee1-sample.md');
writeFileSync(savedReview, '# 샘플 리뷰\n');

const status = {
  version: 1,
  pid: Number(pidText),
  appVersion: version,
  mode: 'post',
  engine: 'claude',
  repos: ['acme/order-api', 'acme/web-console'],
  phase: 'reviewing',
  current: {
    repo: 'acme/order-api',
    pr: 412,
    title: '주문 취소 시 포인트 환불 처리',
    sha: sha('3f9a2c7'),
    startedAt: at(1.4),
  },
  pending: [
    {
      repo: 'acme/web-console',
      pr: 88,
      title: '정산 화면 기간 필터 추가',
      isDraft: true,
      url: 'https://github.com/acme/web-console/pull/88',
      reason: '추가 푸시 대기 중 (42초 남음)',
    },
  ],
  lastPollAt: at(0.3),
  nextPollAt: null,
  lastError: null,
  updatedAt: at(0.1),
};

const runs = [
  {
    at: at(190),
    repo: 'acme/order-api',
    pr: 401,
    title: '배송지 변경 API 추가',
    url: 'https://github.com/acme/order-api/pull/401',
    sha: sha('a1b2c3d'),
    engine: 'claude',
    dryRun: false,
    ok: false,
    durationMs: 900_000,
    error: '리뷰가 제한 시간(900초) 안에 끝나지 않았습니다.',
  },
  {
    at: at(130),
    repo: 'acme/order-api',
    pr: 405,
    title: '쿠폰 중복 적용 방지',
    url: 'https://github.com/acme/order-api/pull/405',
    sha: sha('c0ffee1'),
    engine: 'claude',
    dryRun: true,
    ok: true,
    durationMs: 214_000,
    counts: { P0: 1, P1: 0, P2: 1, P3: 0 },
    posted: false,
    outputPath: savedReview,
  },
  {
    at: at(55),
    repo: 'acme/web-console',
    pr: 85,
    title: '로그인 세션 만료 안내 문구 수정',
    url: 'https://github.com/acme/web-console/pull/85',
    sha: sha('5e6f7a8'),
    engine: 'claude',
    dryRun: false,
    ok: true,
    durationMs: 96_000,
    counts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    posted: true,
    commentUrl: 'https://github.com/acme/web-console/pull/85#pullrequestreview-1',
  },
  {
    at: at(12),
    repo: 'acme/order-api',
    pr: 409,
    title: '결제 승인 재시도 로직 정리',
    url: 'https://github.com/acme/order-api/pull/409',
    sha: sha('7d4e1b2'),
    engine: 'claude',
    dryRun: false,
    ok: true,
    durationMs: 187_000,
    counts: { P0: 0, P1: 1, P2: 2, P3: 0 },
    posted: true,
    commentUrl: 'https://github.com/acme/order-api/pull/409#pullrequestreview-2',
  },
];

writeFileSync(join(stateDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
writeFileSync(join(stateDir, 'runs.jsonl'), runs.map((run) => JSON.stringify(run)).join('\n') + '\n');
