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
    // Простейший keyword-heuristic, а не имитация NLP: без него extractOrder
    // всегда возвращал пустые requiredCapabilities/desiredResources, и
    // matching (Фаза 4) не мог набрать проходной score ни для одного
    // кандидата ни при каких обстоятельствах — семантически весь пайплайн
    // matching был непроверяем на MockAIProvider. Фразы — точные nameRu/
    // synonyms из packages/database/src/seed.ts, чтобы findOntologyNodeForPhrase
    // их узнал.
    const lower = input.text.toLowerCase();
    const requiredCapabilities: string[] = [];
    const requiredResources: string[] = [];
    let regulated = false;
    let requiresQualification = false;

    if (/довез|перевез|доставк/.test(lower)) requiredCapabilities.push("доставка");
    if (/ремонт|почини|сломал/.test(lower)) requiredCapabilities.push("ремонт");
    if (/убра|уборк|почист/.test(lower)) requiredCapabilities.push("уборка");
    if (/собра|сборк/.test(lower)) requiredCapabilities.push("сборка");
    if (/вожу|води[тл]|за рулём|на машине/.test(lower)) requiredCapabilities.push("вождение");
    if (/электрич|проводк/.test(lower)) {
      requiredCapabilities.push("работа с электричеством");
      regulated = true;
      requiresQualification = true;
    }
    if (/газ(?!ель)/.test(lower)) {
      requiredCapabilities.push("работа с газом");
      regulated = true;
      requiresQualification = true;
    }
    if (/газель|грузовик|фургон/.test(lower)) requiredResources.push("использование транспорта");
    if (requiredCapabilities.length === 0) requiredCapabilities.push("физическая работа");

    return wrap({
      normalizedTitle: input.text.slice(0, 60),
      normalizedDescription: input.text,
      actions: [],
      requiredCapabilities,
      desiredCapabilities: [],
      requiredResources,
      desiredResources: [],
      physicalRequirements: [],
      complexity: "low" as const,
      requiresQualification,
      regulated,
      estimatedDurationMinutes: null,
      contextualChips: [],
    });
  },
};

/**
 * Детерминированный, но НЕ вырожденный вектор: cosine distance между двумя
 * нулевыми векторами — NaN (pgvector возвращает NaN, не ошибку), что отравляло
 * бы весь matching score NaN'ом (см. apps/worker/src/handlers/matching-run.ts).
 * Реальные embedding-модели никогда не возвращают нулевой вектор — мок не
 * должен создавать баг, которого не бывает у настоящего провайдера. Простой
 * hash текста как seed даёт: одинаковый текст → одинаковый вектор (полезно
 * для детерминированных тестов), разный текст → разные (не идентичные)
 * векторы, ничего похожего на настоящую семантику не изображаем.
 */
function pseudoEmbedding(text: string, dimensions: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  const vector = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vector[i] = (seed % 2000) / 1000 - 1; // [-1, 1)
  }
  return vector;
}

export const mockEmbedding: EmbeddingProvider = {
  async embed(texts, _meta: AiCallMeta) {
    return wrap({ vectors: texts.map((text) => pseudoEmbedding(text, 1536)) });
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
