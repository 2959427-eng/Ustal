import type { AiCallMeta, AiCallResult } from "./types.js";

/**
 * Строка `ai_runs` (docs/data-model.md) — используется admin `/admin/ai-costs`
 * (docs/api.md). Чистая функция: сама вставка в БД — на стороне вызывающего
 * кода (api/worker), чтобы этот пакет не тянул зависимость на @ustal/database.
 */
export interface AiRunRecord {
  operationType: string;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  startedAt: Date;
  completedAt: Date;
  latencyMs: number;
  status: "success" | "error";
  error: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  estimatedCostMinor: number | null;
  traceId: string;
}

export function buildAiRunRecord(
  meta: AiCallMeta,
  startedAt: Date,
  outcome: { result: AiCallResult<unknown> } | { error: Error },
): AiRunRecord {
  const completedAt = new Date();
  if ("error" in outcome) {
    return {
      operationType: meta.operationType,
      provider: "unknown",
      model: "unknown",
      promptVersion: meta.promptVersion,
      schemaVersion: meta.schemaVersion,
      startedAt,
      completedAt,
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      status: "error",
      error: outcome.error.message,
      tokensInput: null,
      tokensOutput: null,
      estimatedCostMinor: null,
      traceId: meta.traceId,
    };
  }
  const { result } = outcome;
  return {
    operationType: meta.operationType,
    provider: result.provider,
    model: result.model,
    promptVersion: meta.promptVersion,
    schemaVersion: meta.schemaVersion,
    startedAt,
    completedAt,
    latencyMs: result.latencyMs,
    status: "success",
    error: null,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    // TODO: посчитать по RATE_CARD_MINOR_PER_1K_TOKENS (packages/ai/providers/openai.ts),
    // когда OpenAI-провайдер будет реально подключён.
    estimatedCostMinor: null,
    traceId: meta.traceId,
  };
}
