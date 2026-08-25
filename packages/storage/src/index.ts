import { loadEnv } from "@ustal/config";
import type { MediaStorageProvider } from "./types.js";
import { createLocalDiskStorage } from "./providers/local-disk.js";
import { createS3Storage } from "./providers/s3.js";

export * from "./types.js";

let cached: MediaStorageProvider | undefined;

/**
 * Единая точка получения провайдера — читает MEDIA_STORAGE_PROVIDER из
 * конфигурации. OBJECT_STORAGE_* — `.optional()` в схеме env (см.
 * packages/config/src/env.ts, они не нужны при MEDIA_STORAGE_PROVIDER=local),
 * но обязательны в рантайме при MEDIA_STORAGE_PROVIDER=s3 — здесь, а не в
 * схеме, потому что схема не умеет условной обязательности между двумя
 * независимыми полями без усложнения общего контракта.
 */
export function getMediaStorage(): MediaStorageProvider {
  if (cached) return cached;
  const env = loadEnv();
  if (env.MEDIA_STORAGE_PROVIDER === "s3") {
    const missing = (
      [
        ["OBJECT_STORAGE_ENDPOINT", env.OBJECT_STORAGE_ENDPOINT],
        ["OBJECT_STORAGE_ACCESS_KEY", env.OBJECT_STORAGE_ACCESS_KEY],
        ["OBJECT_STORAGE_SECRET_KEY", env.OBJECT_STORAGE_SECRET_KEY],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `MEDIA_STORAGE_PROVIDER=s3, но не заданы: ${missing.join(", ")}. ` +
          `Задайте их в .env (см. .env.example) или переключитесь на MEDIA_STORAGE_PROVIDER=local для разработки.`,
      );
    }
    cached = createS3Storage({
      endpoint: env.OBJECT_STORAGE_ENDPOINT as string,
      bucket: env.OBJECT_STORAGE_BUCKET,
      accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY as string,
      secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY as string,
    });
  } else {
    cached = createLocalDiskStorage(env.MEDIA_LOCAL_DIR);
  }
  return cached;
}
