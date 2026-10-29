import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecError, run } from '../exec.ts';
import type { Workspace } from '../workspace.ts';
import type { EngineOutput, EngineSettings } from './engine.ts';
import { parseReviewResult, REVIEW_SCHEMA } from './schema.ts';

export function buildCodexArgs(settings: EngineSettings, schemaPath: string, outputPath: string): string[] {
  const args = [
    'exec',
    // 모델이 실행하는 명령은 쓰기가 막힌 샌드박스에서 돈다.
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
  ];
  if (settings.model) args.push('--model', settings.model);
  // 프롬프트는 표준 입력으로 받는다.
  args.push('-');
  return args;
}

export async function reviewWithCodex(workspace: Workspace, prompt: string, settings: EngineSettings): Promise<EngineOutput> {
  // 스키마와 결과 파일은 worktree 밖 임시 디렉터리에 둔다.
  const tempDir = await mkdtemp(join(tmpdir(), 'pr-ai-reviewer-codex-'));
  try {
    const schemaPath = join(tempDir, 'schema.json');
    const outputPath = join(tempDir, 'result.json');
    await writeFile(schemaPath, JSON.stringify(REVIEW_SCHEMA), 'utf8');

    const args = buildCodexArgs(settings, schemaPath, outputPath);
    const result = await run('codex', args, { cwd: workspace.dir, input: prompt, timeoutMs: settings.timeoutSec * 1000 });
    if (result.timedOut) throw new Error(`Codex 리뷰가 ${settings.timeoutSec}초 안에 끝나지 않았습니다.`);
    if (result.code !== 0) throw new ExecError('codex', args, result);

    const text = await readFile(outputPath, 'utf8');
    return {
      result: parseReviewResult(JSON.parse(text)),
      model: settings.model ?? 'default',
      costUsd: null,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
