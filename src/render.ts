import type { EngineName } from './config.ts';
import type { PullRequest } from './github.ts';
import { buildMarker } from './marker.ts';
import { countBySeverity, SEVERITIES, type ReviewResult } from './review/schema.ts';

export interface RenderInput {
  pr: PullRequest;
  sha: string;
  engine: EngineName;
  model: string;
  durationMs: number;
  result: ReviewResult;
  truncated: boolean;
  diffLines: number;
}

const ENGINE_LABEL: Record<EngineName, string> = { claude: 'Claude Code', codex: 'Codex' };

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

export function renderReview(input: RenderInput): string {
  const { result } = input;
  const counts = countBySeverity(result.findings);
  const countText = SEVERITIES.map((severity) => `${severity} ${counts[severity]}건`).join(' · ');
  const ordered = [...result.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

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
  lines.push('', `**요약** ${sanitize(result.summary)}`);

  if (ordered.length === 0) {
    lines.push('', '지적 사항이 없습니다.');
  }
  for (const finding of ordered) {
    const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
    lines.push('', `#### [${finding.severity}] ${sanitize(finding.title)}`, `\`${sanitize(location)}\``, '', sanitize(finding.detail));
    if (finding.suggestion.trim() !== '') lines.push('', `제안: ${sanitize(finding.suggestion)}`);
  }
  lines.push(
    '',
    '---',
    '<sub>pr-ai-reviewer가 PR 작성자의 PC에서 실행한 결과입니다. P1 이상은 반영 여부와 이유를 답글로 남겨 주세요.</sub>',
    '',
  );
  return lines.join('\n');
}
