/**
 * Настройки, которые продукт должен уметь менять без деплоя (пороги matching,
 * веса scoring, rate limits). В MVP читаются из ENV/значений по умолчанию;
 * при появлении админ-UI для этих настроек источником станет таблица в БД —
 * контракт этого модуля (getRuntimeConfig()) при этом не изменится.
 */
import { loadEnv } from "./env.js";

export interface MatchingWeights {
  explicitCapabilityMatch: number;
  inferredCapabilityMatch: number;
  resourceMatch: number;
  semanticSimilarity: number;
  similarCompletedWork: number;
  behavioralPreference: number;
  missingRequirementPenalty: number;
  negativePreferencePenalty: number;
  riskPenalty: number;
}

export interface RuntimeConfig {
  matching: {
    weights: MatchingWeights;
    minimumRelevanceScore: number;
  };
  rateLimits: {
    profileFreeformEditsPerHour: number;
    contactUnlocksPerHour: number;
  };
  ai: {
    provider: "openai" | "mock";
    baseUrl?: string;
    models: {
      extraction: string;
      moderation: string;
      embedding: string;
      stt: string;
    };
  };
}

const DEFAULT_MATCHING_WEIGHTS: MatchingWeights = {
  explicitCapabilityMatch: 0.3,
  inferredCapabilityMatch: 0.15,
  resourceMatch: 0.15,
  semanticSimilarity: 0.15,
  similarCompletedWork: 0.1,
  behavioralPreference: 0.15,
  missingRequirementPenalty: 0.3,
  negativePreferencePenalty: 0.2,
  riskPenalty: 0.5,
};

export function getRuntimeConfig(): RuntimeConfig {
  const env = loadEnv();
  return {
    matching: {
      weights: DEFAULT_MATCHING_WEIGHTS,
      // Откалибровано в Фазе 4 (было 35 — взято "с потолка" в Фазе 0, ничем не
      // проверено). При заданных весах максимум ОДНОГО сильного сигнала:
      // explicit capability match — 30 баллов, inferred/resource match — 15,
      // semantic similarity — до 15. Порог 35 отсеивал бы вообще всё, включая
      // безупречное точное совпадение способности без других сигналов — порог
      // не может быть выше максимума одного компонента. 10 — заведомо выше
      // "случайного" совпадения (нулевые компоненты дают 0), но пропускает
      // любой один настоящий структурный сигнал (inferred/resource match).
      minimumRelevanceScore: 10,
    },
    rateLimits: {
      profileFreeformEditsPerHour: env.PROFILE_FREEFORM_EDITS_PER_HOUR,
      contactUnlocksPerHour: env.CONTACT_UNLOCKS_PER_HOUR,
    },
    ai: {
      provider: env.AI_PROVIDER,
      baseUrl: env.OPENAI_BASE_URL,
      models: {
        extraction: env.AI_MODEL_EXTRACTION,
        moderation: env.AI_MODEL_MODERATION,
        embedding: env.AI_MODEL_EMBEDDING,
        stt: env.AI_MODEL_STT,
      },
    },
  };
}
