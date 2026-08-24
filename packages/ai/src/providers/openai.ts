import type {
  AiCallMeta,
  AiCallResult,
  AiProviderBundle,
  EmbeddingProvider,
  ModerationProvider,
  SpeechToTextProvider,
  StructuredExtractionProvider,
} from "../types.js";
import { capabilityExtractionResultSchema, orderExtractionResultSchema } from "@ustal/validation";

/**
 * OpenAI-реализация (выбрана как провайдер по умолчанию, см. .env.example):
 *  - STT:        whisper-1
 *  - extraction: gpt-4o-mini (structured outputs / JSON mode + Zod-валидация ответа)
 *  - embeddings: text-embedding-3-small (1536 измерений — см. packages/database schema)
 *  - moderation: правила (см. moderateWithRules) + gpt-4o-mini только для пограничных
 *    случаев, как того требует раздел 12 ТЗ ("не полноценный LLM-вызов на каждый заказ").
 *
 * Системная часть промпта (инструкции + JSON Schema + few-shot) вынесена в
 * SYSTEM_PROMPT_* константы ниже и не меняется между вызовами — это то, что
 * провайдер может закешировать (OpenAI prompt caching для длинных статичных
 * префиксов, начиная с определённой длины, включается автоматически).
 *
 * Реализация — заготовка Фазы 2. Здесь зафиксирован контракт вызовов к
 * OpenAI SDK; фактическая интеграция (клиент, retries, error handling)
 * добавляется вместе с extraction pipeline.
 */

const SYSTEM_PROMPT_CAPABILITY_EXTRACTION = `Ты извлекаешь структурированный профиль возможностей человека
из свободного текста на русском языке. Верни JSON строго по схеме:
capabilities[], resources[] — с полями label, evidenceType, confidence.
Не придумывай способности, которых нет в тексте или логически не следуют из него.`;

const SYSTEM_PROMPT_ORDER_EXTRACTION = `Ты извлекаешь структурированное описание заказа на услугу
из свободного текста на русском языке. Верни JSON строго по схеме с полями
normalizedTitle, normalizedDescription, requiredCapabilities, requiredResources и т.д.`;

export const RATE_CARD_MINOR_PER_1K_TOKENS = {
  "gpt-4o-mini": { input: 15, output: 60 }, // копейки / 1000 токенов, ориентировочно
  "text-embedding-3-small": { input: 2, output: 0 },
  "whisper-1": { input: 0, output: 0 }, // тарифицируется по времени аудио, не по токенам
};

function notImplemented(name: string): never {
  throw new Error(
    `OpenAI provider "${name}" not wired yet — Фаза 2. Используйте AI_PROVIDER=mock для локальной разработки.`,
  );
}

export const openAiStt: SpeechToTextProvider = {
  async transcribe(_audio, _meta: AiCallMeta): Promise<AiCallResult<{ transcript: string }>> {
    notImplemented("transcribe");
  },
};

export const openAiExtraction: StructuredExtractionProvider = {
  async extractCapabilityProfile(_input, _meta: AiCallMeta) {
    // Реализация: chat.completions.create({ model, response_format: json_schema,
    // messages: [{role:'system', content: SYSTEM_PROMPT_CAPABILITY_EXTRACTION}, ...] })
    // затем capabilityExtractionResultSchema.parse(response) перед возвратом.
    void capabilityExtractionResultSchema;
    void SYSTEM_PROMPT_CAPABILITY_EXTRACTION;
    notImplemented("extractCapabilityProfile");
  },
  async extractOrder(_input, _meta: AiCallMeta) {
    void orderExtractionResultSchema;
    void SYSTEM_PROMPT_ORDER_EXTRACTION;
    notImplemented("extractOrder");
  },
};

export const openAiEmbedding: EmbeddingProvider = {
  async embed(_texts, _meta: AiCallMeta) {
    notImplemented("embed");
  },
};

/**
 * Раздел 12 ТЗ: детерминированные случаи — ключевые слова явных категорий
 * риска (оружие, наркотики, несовершеннолетние и т.п.) — отсекаются правилами
 * без обращения к LLM. AI-вызов используется только для пограничных случаев.
 */
const HARD_BLOCK_KEYWORDS = ["оружие", "наркотик", "несовершеннолет"];

export function moderateWithRules(text: string): { decision: "reject" | "manual_review" | null; reason?: string } {
  const lower = text.toLowerCase();
  for (const kw of HARD_BLOCK_KEYWORDS) {
    if (lower.includes(kw)) return { decision: "reject", reason: `rule: keyword "${kw}"` };
  }
  return { decision: null }; // не решено правилами — эскалируется на AI-модерацию
}

export const openAiModeration: ModerationProvider = {
  async moderate(input, _meta: AiCallMeta) {
    const ruleResult = moderateWithRules(input.text);
    if (ruleResult.decision) {
      return {
        data: { decision: ruleResult.decision, reason: ruleResult.reason ?? "" },
        provider: "rules",
        model: "keyword-rules-v1",
        tokensInput: 0,
        tokensOutput: 0,
        latencyMs: 0,
      };
    }
    notImplemented("moderate (AI fallback)");
  },
};

export const openAiProviders: AiProviderBundle = {
  stt: openAiStt,
  extraction: openAiExtraction,
  embedding: openAiEmbedding,
  moderation: openAiModeration,
};
