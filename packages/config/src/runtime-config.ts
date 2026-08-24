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
      minimumRelevanceScore: 35,
    },
    rateLimits: {
      profileFreeformEditsPerHour: env.PROFILE_FREEFORM_EDITS_PER_HOUR,
      contactUnlocksPerHour: env.CONTACT_UNLOCKS_PER_HOUR,
    },
    ai: {
      provider: env.AI_PROVIDER,
      models: {
        extraction: env.AI_MODEL_EXTRACTION,
        moderation: env.AI_MODEL_MODERATION,
        embedding: env.AI_MODEL_EMBEDDING,
        stt: env.AI_MODEL_STT,
      },
    },
  };
}
