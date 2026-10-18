/**
 * Настройки, которые продукт должен уметь менять без деплоя (rate limits,
 * модели AI). Пороги matching живут в SEMANTIC_POLICY (@ustal/matching). В MVP читаются из ENV/значений по умолчанию;
 * при появлении админ-UI для этих настроек источником станет таблица в БД —
 * контракт этого модуля (getRuntimeConfig()) при этом не изменится.
 */
import { loadEnv } from "./env.js";

export interface RuntimeConfig {
  rateLimits: {
    profileFreeformEditsPerHour: number;
    profileItemActionsPerHour: number;
    contactUnlocksPerHour: number;
    ordersPerHour: number;
    reportsPerHour: number;
    mediaUploadsPerHour: number;
    mediaStorageMaxBytesPerUser: number;
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

export function getRuntimeConfig(): RuntimeConfig {
  const env = loadEnv();
  return {
    rateLimits: {
      profileFreeformEditsPerHour: env.PROFILE_FREEFORM_EDITS_PER_HOUR,
      profileItemActionsPerHour: env.PROFILE_ITEM_ACTIONS_PER_HOUR,
      contactUnlocksPerHour: env.CONTACT_UNLOCKS_PER_HOUR,
      ordersPerHour: env.ORDERS_PER_HOUR,
      reportsPerHour: env.REPORTS_PER_HOUR,
      mediaUploadsPerHour: env.MEDIA_UPLOADS_PER_HOUR,
      mediaStorageMaxBytesPerUser: env.MEDIA_STORAGE_MAX_BYTES_PER_USER,
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
