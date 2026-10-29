import type { ReviewResult } from './schema.ts';

export interface EngineOutput {
  result: ReviewResult;
  /** 실제로 쓴 모델 이름. CLI가 알려 주지 않으면 설정값 또는 'default'. */
  model: string;
  /** CLI가 보고한 비용(USD). 구독 사용 시 실제 청구액이 아니라 환산값이다. */
  costUsd: number | null;
}

export interface EngineSettings {
  model: string | null;
  maxBudgetUsd: number | null;
  timeoutSec: number;
  claudeSettingSources: string;
}
