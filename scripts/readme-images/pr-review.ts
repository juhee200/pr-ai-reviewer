// README 스크린샷용 PR 리뷰 화면을 HTML로 만든다.
// 리뷰 본문과 코드 줄 코멘트는 실제 게시 코드(src/render.ts)로 만들고, 마크다운은 GitHub 마크다운 API(gh api markdown)로 바꾼다.
// 사용법: node scripts/readme-images/pr-review.ts <출력 HTML 경로>
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { buildReviewPost, type RenderInput } from '../../src/render.ts';

const output = process.argv[2];
if (!output) {
  console.error('사용법: node pr-review.ts <출력 HTML 경로>');
  process.exit(1);
}

const SERVICE = 'src/main/kotlin/com/acme/order/payment/PaymentRetryService.kt';
const CLIENT = 'src/main/kotlin/com/acme/order/payment/PaymentClient.kt';

/** head 커밋 기준 PaymentRetryService.kt 36~52줄. 이번 PR에서 추가한 줄이다. */
const serviceLines: Record<number, string> = {
  36: '    fun approveWithRetry(order: Order): PaymentResult {',
  37: '        var lastError: Exception? = null',
  38: '        repeat(MAX_ATTEMPTS) { attempt ->',
  39: '            try {',
  40: '                val request = ApprovalRequest(',
  41: '                    orderId = order.id,',
  42: '                    amount = order.totalAmount,',
  43: '                    idempotencyKey = UUID.randomUUID().toString(),',
  44: '                )',
  45: '                return paymentClient.approve(request)',
  46: '            } catch (e: PaymentTimeoutException) {',
  47: '                lastError = e',
  48: '                Thread.sleep(backoffMillis(attempt))',
  49: '            }',
  50: '        }',
  51: '        throw PaymentFailedException("결제 승인 실패: ${order.id}")',
  52: '    }',
};

const input: RenderInput = {
  pr: {
    repo: 'acme/order-api',
    number: 409,
    title: '결제 승인 재시도 로직 정리',
    isDraft: false,
    headSha: '7d4e1b27d4e1b27d4e1b27d4e1b27d4e1b27d4e1',
    headRef: 'feature/payment-retry',
    baseRef: 'main',
    url: 'https://github.com/acme/order-api/pull/409',
    updatedAt: '2026-11-05T01:00:00Z',
  },
  sha: '7d4e1b27d4e1b27d4e1b27d4e1b27d4e1b27d4e1',
  engine: 'claude',
  model: 'claude-opus-5-5',
  durationMs: 187_000,
  truncated: false,
  diffLines: 214,
  result: {
    summary:
      '결제 승인이 타임아웃으로 실패하면 최대 3회 다시 시도하도록 바꾼 PR입니다. 재시도마다 멱등 키가 바뀌어 한 주문이 두 번 승인될 수 있어 P1로 표시했습니다.',
    findings: [
      {
        severity: 'P2',
        file: SERVICE,
        line: 51,
        endLine: null,
        title: '마지막 예외를 원인으로 넘기지 않음',
        detail:
          '`lastError`에 담기만 하고 `PaymentFailedException`에 넘기지 않아, 실패 로그에서 타임아웃인지 다른 오류인지 구분할 수 없습니다.',
        suggestion: '`PaymentFailedException("결제 승인 실패: ${order.id}", lastError)`처럼 cause로 넘기세요.',
      },
      {
        severity: 'P1',
        file: SERVICE,
        line: 40,
        endLine: 44,
        title: '재시도마다 멱등 키를 새로 만들어 이중 승인 가능',
        detail:
          'PG가 승인을 처리했지만 응답만 늦은 경우에도 `PaymentTimeoutException`이 납니다. 재시도에서 새 UUID를 보내면 PG는 다른 요청으로 보고 같은 주문을 한 번 더 승인합니다.',
        suggestion: '멱등 키를 반복문 밖에서 주문 ID 기준으로 한 번 만들고, 모든 재시도에 같은 값을 보내세요.',
      },
      {
        severity: 'P2',
        file: CLIENT,
        line: 21,
        endLine: 24,
        title: 'PG 클라이언트에 읽기 타임아웃이 없음',
        detail:
          '이번 PR의 재시도는 `PaymentTimeoutException`이 나야 동작합니다. 클라이언트에 연결·읽기 타임아웃이 없어 PG가 응답하지 않으면 요청 스레드가 계속 기다리고 재시도가 실행되지 않습니다.',
        suggestion: '`SimpleClientHttpRequestFactory`에 `setConnectTimeout`과 `setReadTimeout`을 설정하세요.',
      },
    ],
  },
  quotes: [
    null,
    null,
    {
      startLine: 21,
      lines: [
        '    private val restClient = RestClient.builder()',
        '        .baseUrl(properties.baseUrl)',
        '        .requestFactory(SimpleClientHttpRequestFactory())',
        '        .build()',
      ],
      omittedLines: 0,
    },
  ],
};

// PaymentRetryService.kt는 이번 PR에서 추가한 파일이라 36~52줄이 diff에 있고, PaymentClient.kt는 diff에 없다.
const post = buildReviewPost(input, new Map([[SERVICE, [{ start: 36, end: 52 }]]]));

function markdown(text: string): string {
  return execFileSync('gh', ['api', 'markdown', '-f', `text=${text}`, '-f', 'mode=gfm', '-f', `context=${input.pr.repo}`], {
    encoding: 'utf8',
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** GitHub가 코멘트 위에 보여 주는 코드 줄. 여러 줄 코멘트는 지적한 범위를, 한 줄 코멘트는 앞 3줄까지 보여 준다. */
function codeRows(startLine: number | null, line: number): string {
  const first = startLine ?? Math.max(36, line - 3);
  const rows: string[] = [];
  for (let n = first; n <= line; n += 1) {
    const commented = startLine === null ? n === line : true;
    rows.push(
      `<tr class="${commented ? 'sel' : ''}"><td class="num"></td><td class="num">${n}</td><td class="code">+${escapeHtml(serviceLines[n] ?? '')}</td></tr>`,
    );
  }
  return rows.join('');
}

const avatar = '<div class="avatar">S</div>';

const threads = post.comments
  .map(
    (comment) => `
  <div class="thread">
    <div class="file">${escapeHtml(comment.path)}</div>
    <table class="diff">${codeRows(comment.startLine, comment.line)}</table>
    <div class="comment">
      ${avatar}
      <div class="comment-main">
        <div class="meta"><b>sample-dev</b> <span class="muted">3 minutes ago</span></div>
        <div class="markdown-body">${markdown(comment.body)}</div>
      </div>
    </div>
  </div>`,
  )
  .join('\n');

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #fff; color: #1f2328;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo", sans-serif; }
  .timeline { position: relative; padding-left: 56px; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; background: #8250df; color: #fff; font-weight: 600;
    display: flex; align-items: center; justify-content: center; flex: none; }
  .review-head { display: flex; align-items: center; gap: 8px; margin-left: -44px; margin-bottom: 12px; }
  .badge { width: 32px; height: 32px; border-radius: 50%; background: #eaeef2; color: #59636e; display: flex;
    align-items: center; justify-content: center; font-size: 15px; }
  .muted { color: #59636e; }
  .box { border: 1px solid #d1d9e0; border-radius: 6px; }
  .box-head { background: #f6f8fa; border-bottom: 1px solid #d1d9e0; padding: 8px 16px; border-radius: 6px 6px 0 0; }
  .box-body { padding: 16px; }
  .thread { border: 1px solid #d1d9e0; border-radius: 6px; margin-top: 16px; overflow: hidden; }
  .file { background: #f6f8fa; border-bottom: 1px solid #d1d9e0; padding: 8px 16px;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  table.diff { width: 100%; border-collapse: collapse; font: 12px/20px ui-monospace, SFMono-Regular, Menlo, monospace; }
  table.diff td { padding: 0 10px; white-space: pre; }
  table.diff td.num { width: 1%; text-align: right; color: #59636e; background: #d1f8d9; }
  table.diff td.code { background: #dafbe1; width: 100%; }
  table.diff tr.sel td { background: #fff8c5; }
  table.diff tr.sel td.num { background: #fae17d; }
  .comment { display: flex; gap: 12px; padding: 16px; border-top: 1px solid #d1d9e0; }
  .comment .avatar { width: 28px; height: 28px; font-size: 13px; }
  .comment-main { flex: 1; min-width: 0; }
  .meta { margin-bottom: 4px; }
  .markdown-body > :first-child { margin-top: 0; }
  .markdown-body > :last-child { margin-bottom: 0; }
  .markdown-body p, .markdown-body ul, .markdown-body pre { margin: 0 0 12px; }
  .markdown-body ul { padding-left: 2em; }
  .markdown-body h3 { font-size: 1.25em; margin: 0 0 12px; }
  .markdown-body h4 { font-size: 1em; margin: 20px 0 8px; }
  .markdown-body code { font: 85% ui-monospace, SFMono-Regular, Menlo, monospace; background: #eff1f3;
    padding: .2em .4em; border-radius: 6px; }
  .markdown-body pre { background: #f6f8fa; padding: 12px 16px; border-radius: 6px; overflow: hidden; }
  .markdown-body pre code { background: none; padding: 0; font-size: 12px; }
  .markdown-body hr { border: 0; border-top: 1px solid #d1d9e0; margin: 16px 0; }
  .markdown-body sub { color: #59636e; }
  .markdown-body .pl-k { color: #cf222e; } .markdown-body .pl-s { color: #0a3069; }
  .markdown-body .pl-en { color: #8250df; } .markdown-body .pl-c1 { color: #0550ae; }
  .markdown-body .pl-smi, .markdown-body .pl-v { color: #953800; }
</style>
</head>
<body>
<div class="timeline">
  <div class="review-head">
    ${avatar}
    <div><b>sample-dev</b> <span class="muted">reviewed 3 minutes ago</span></div>
  </div>
  <div class="box">
    <div class="box-head"><b>sample-dev</b> <span class="muted">left a comment</span></div>
    <div class="box-body markdown-body">${markdown(post.body)}</div>
  </div>
  ${threads}
</div>
</body>
</html>
`;

writeFileSync(output, html);
