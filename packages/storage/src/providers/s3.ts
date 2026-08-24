import type { MediaStorageProvider } from "../types.js";

/**
 * Timeweb Cloud Object Storage (S3-совместимое) — см. OBJECT_STORAGE_* в
 * packages/config. Заготовка Фазы 2, как и openAiProviders в packages/ai:
 * контракт вызовов зафиксирован, реальная интеграция (@aws-sdk/client-s3,
 * подписанные URL) добавляется вместе с боевыми credentials.
 */
function notImplemented(name: string): never {
  throw new Error(
    `S3 media storage "${name}" not wired yet — задайте MEDIA_STORAGE_PROVIDER=local для разработки, ` +
      `либо предоставьте OBJECT_STORAGE_* credentials для боевого включения.`,
  );
}

export const s3Storage: MediaStorageProvider = {
  name: "s3",
  async upload() {
    notImplemented("upload");
  },
  resolvePath() {
    notImplemented("resolvePath");
  },
};
