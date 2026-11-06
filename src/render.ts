import type { EngineName } from './config.ts';
import { findCommentRange, normalizeFindingPath, type LineRange } from './diff.ts';
import type { PullRequest } from './github.ts';
import { buildMarker } from './marker.ts';
import type { CodeQuote } from './quote.ts';
import { countBySeverity, SEVERITIES, type Finding, type Severity, type ReviewResult } from './review/schema.ts';

export interface RenderInput {
  pr: PullRequest;
  sha: string;
  engine: EngineName;
  model: string;
  durationMs: number;
  result: ReviewResult;
  /** result.findings와 같은 순서의 코드 인용. 읽지 못한 지적은 null. */
  quotes?: ReadonlyArray<CodeQuote | null>;
  truncated: boolean;
  diffLines: number;
}

/** PR 리뷰의 코드 줄 코멘트 한 건. 줄 번호는 head 커밋 기준이다. */
export interface ReviewComment {
  path: string;
  /** 여러 줄 코멘트의 첫 줄. 한 줄이면 null. */
  startLine: number | null;
  line: number;
  body: string;
}

/** PR에 올리는 리뷰. 코드 줄에 달 수 있는 지적은 comments로, 나머지는 body에 넣는다. */
export interface ReviewPost {
  body: string;
  comments: ReviewComment[];
}

const ENGINE_LABEL: Record<EngineName, string> = { claude: 'Claude Code', codex: 'Codex' };

export const SEVERITY_EMOJI: Record<Severity, string> = { P0: '🔴', P1: '🟠', P2: '🟡', P3: '🔵' };

interface Item {
  finding: Finding;
  quote: CodeQuote | null;
}

/**
 * AI가 쓴 문장은 그대로 PR에 올라가므로 두 가지를 무력화한다.
 * - `@아이디`: GitHub가 해당 사용자에게 알림을 보낸다.
 * - `<!--`: 숨은 HTML 주석으로 다른 커밋의 리뷰 표식을 흉내 낼 수 있다.
 */
export function sanitize(text: string): string {
  // 백틱 코드 표기 안의 멘션은 알림이 가지 않으므로 코드(@ivar 등)를 그대로 둔다.
  const withoutMentions = text
    .split(/(`[^`\n]*`)/)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : part.replace(/@(?=[A-Za-z0-9-])/g, '@​')))
    .join('');
  // 숨은 주석은 코드 표기 안에 있어도 표식 검사에 걸리므로 항상 무력화한다.
  return withoutMentions.replace(/<!--/g, '&lt;!--');
}

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

/** 모든 지적을 본문 하나에 담는다. 로컬 파일, 표준 출력에 쓴다. */
export function renderReview(input: RenderInput): string {
  return buildReviewPost(input, new Map()).body;
}

/**
 * PR 리뷰를 만든다. diff에 나오는 줄을 가리키는 지적은 그 줄의 코멘트로 달아 지적마다 답글 스레드가 생기게 하고,
 * diff 밖을 가리키거나 줄이 없는 지적은 코드를 인용해 본문에 넣는다.
 */
export function buildReviewPost(input: RenderInput, diffLineRanges: ReadonlyMap<string, readonly LineRange[]>): ReviewPost {
  const comments: ReviewComment[] = [];
  const bodyItems: Item[] = [];
  for (const item of orderedItems(input)) {
    const { finding } = item;
    const range = findCommentRange(diffLineRanges, finding.file, finding.line, finding.endLine);
    if (range === null) {
      bodyItems.push(item);
      continue;
    }
    comments.push({
      path: normalizeFindingPath(finding.file),
      startLine: range.start < range.end ? range.start : null,
      line: range.end,
      body: renderCommentBody(finding, input.engine),
    });
  }
  return { body: renderBody(input, bodyItems, comments.length), comments };
}

function orderedItems(input: RenderInput): Item[] {
  const items = input.result.findings.map((finding, index) => ({ finding, quote: input.quotes?.[index] ?? null }));
  return items.sort((a, b) => SEVERITIES.indexOf(a.finding.severity) - SEVERITIES.indexOf(b.finding.severity));
}

function severityLabel(severity: Severity): string {
  return `${SEVERITY_EMOJI[severity]} [${severity}]`;
}

function renderBody(input: RenderInput, items: readonly Item[], inlineCount: number): string {
  const counts = countBySeverity(input.result.findings);
  const countText = SEVERITIES.map((severity) => `${SEVERITY_EMOJI[severity]} ${severity} ${counts[severity]}건`).join(' · ');
  const lines: string[] = [
    buildMarker(input.sha, input.engine),
    `### AI 리뷰 (작성자 PC의 ${ENGINE_LABEL[input.engine]}에서 실행)`,
    '',
    `- 대상 커밋: \`${input.sha.slice(0, 7)}\``,
    `- 엔진: ${input.engine} (${sanitize(input.model)}) · 소요 ${formatDuration(input.durationMs)}`,
    `- 결과: ${countText}`,
  ];
  if (input.truncated) {
    lines.push(`- diff가 ${input.diffLines}줄이라 앞부분만 프롬프트에 넣었고, 나머지는 AI가 git으로 직접 읽었습니다.`);
  }
  lines.push('', `**요약** ${sanitize(input.result.summary)}`);

  if (input.result.findings.length === 0) {
    lines.push('', '지적 사항이 없습니다.');
  }
  if (inlineCount > 0) {
    lines.push('', `지적 ${inlineCount}건은 해당 코드 줄에 코멘트로 남겼습니다.`);
    if (items.length > 0) lines.push(`아래 ${items.length}건은 이번 diff에 없는 줄을 가리켜 코드 줄에 달 수 없어 본문에 남깁니다.`);
  }
  for (const { finding, quote } of items) {
    lines.push('', `#### ${severityLabel(finding.severity)} ${sanitize(finding.title)}`, `\`${sanitize(formatLocation(finding))}\``);
    if (quote !== null) lines.push('', ...renderQuote(finding.file, quote));
    lines.push('', sanitize(finding.detail));
    if (finding.suggestion.trim() !== '') lines.push('', `제안: ${sanitize(finding.suggestion)}`);
  }
  lines.push(
    '',
    '---',
    '<sub>리뷰엉이(review-owl)가 PR 작성자의 PC에서 실행한 결과입니다. P1 이상은 지적마다 반영 여부와 이유를 답글로 남겨 주세요.</sub>',
    '',
  );
  return lines.join('\n');
}

function renderCommentBody(finding: Finding, engine: EngineName): string {
  const lines = [`**${severityLabel(finding.severity)} ${sanitize(finding.title)}**`, '', sanitize(finding.detail)];
  if (finding.suggestion.trim() !== '') lines.push('', `제안: ${sanitize(finding.suggestion)}`);
  lines.push('', `<sub>AI 리뷰 · ${ENGINE_LABEL[engine]}</sub>`);
  return lines.join('\n');
}

function formatLocation(finding: Finding): string {
  if (finding.line === null) return finding.file;
  return finding.endLine === null ? `${finding.file}:${finding.line}` : `${finding.file}:${finding.line}-${finding.endLine}`;
}

/** 코드 블록으로 인용한다. 코드 안의 백틱이 블록을 닫지 못하게 더 긴 펜스를 쓴다. */
export function renderQuote(file: string, quote: CodeQuote): string[] {
  // 코드 블록 안의 숨은 주석도 표식 검사에는 걸리므로 보이는 모양은 두고 문자열만 끊는다.
  const code = quote.lines.map((line) => line.replace(/<!--/g, '<!​--'));
  const longestRun = Math.max(0, ...code.map((line) => Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length))));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const lines = [`${fence}${codeLanguage(file)}`, ...code, fence];
  if (quote.omittedLines > 0) lines.push(`<sub>이하 ${quote.omittedLines}줄 생략</sub>`);
  return lines;
}

/** GitHub 코드 블록은 확장자를 언어 이름으로 받는다. */
function codeLanguage(file: string): string {
  const name = file.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}
