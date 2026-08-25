/**
 * Ориентировочные тарифы OpenAI, копейки / 1000 токенов (округлено на момент
 * написания, см. docs/architecture.md §5 — не источник истины для биллинга,
 * только для `/admin/ai-costs` как оценка порядка величины). Вынесено из
 * providers/openai.ts в отдельный модуль, чтобы record-run.ts (провайдеро-
 * агностичный по замыслу) мог посчитать `estimatedCostMinor` не импортируя
 * напрямую конкретную реализацию провайдера.
 */
export const RATE_CARD_MINOR_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 15, output: 60 },
  "text-embedding-3-small": { input: 2, output: 0 },
  "whisper-1": { input: 0, output: 0 }, // тарифицируется по времени аудио, не по токенам — не считаем здесь
};

export function estimateCostMinor(model: string, tokensInput: number | null, tokensOutput: number | null): number | null {
  const rate = RATE_CARD_MINOR_PER_1K_TOKENS[model];
  if (!rate || tokensInput == null || tokensOutput == null) return null;
  const cost = (tokensInput / 1000) * rate.input + (tokensOutput / 1000) * rate.output;
  return Math.round(cost);
}
