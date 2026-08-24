import type {
  AiCallMeta,
  AiCallResult,
  AiProviderBundle,
  EmbeddingProvider,
  ModerationProvider,
  SpeechToTextProvider,
  StructuredExtractionProvider,
} from "../types.js";

/**
 * Детерминированный mock для локальной разработки и тестов — без сетевых
 * вызовов и без реальных ключей. Используется по умолчанию, пока
 * AI_PROVIDER=mock (см. .env.example).
 */
function wrap<T>(data: T): AiCallResult<T> {
  return { data, provider: "mock", model: "mock-v1", tokensInput: 0, tokensOutput: 0, latencyMs: 1 };
}

export const mockStt: SpeechToTextProvider = {
  async transcribe(_audio, _meta: AiCallMeta) {
    return wrap({ transcript: "[mock transcript] расскажите, что вы умеете делать" });
  },
};

export const mockExtraction: StructuredExtractionProvider = {
  async extractCapabilityProfile(input, _meta: AiCallMeta) {
    return wrap({
      summary: `Извлечено из: "${input.text.slice(0, 60)}"`,
      capabilities: [
        { label: "физическая работа", proficiency: "basic", evidenceType: "inferred", confidence: 0.6 },
      ],
      resources: [],
    });
  },
  async extractOrder(input, _meta: AiCallMeta) {
    return wrap({
      normalizedTitle: input.text.slice(0, 60),
      normalizedDescription: input.text,
      actions: [],
      requiredCapabilities: [],
      desiredCapabilities: [],
      requiredResources: [],
      desiredResources: [],
      physicalRequirements: [],
      complexity: "low" as const,
      requiresQualification: false,
      regulated: false,
      estimatedDurationMinutes: null,
      contextualChips: [],
    });
  },
};

export const mockEmbedding: EmbeddingProvider = {
  async embed(texts, _meta: AiCallMeta) {
    return wrap({ vectors: texts.map(() => new Array(1536).fill(0)) });
  },
};

export const mockModeration: ModerationProvider = {
  async moderate(_input, _meta: AiCallMeta) {
    return wrap({ decision: "allow" as const, reason: "mock: no risk detected" });
  },
};

export const mockProviders: AiProviderBundle = {
  stt: mockStt,
  extraction: mockExtraction,
  embedding: mockEmbedding,
  moderation: mockModeration,
};
