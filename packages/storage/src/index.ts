import { loadEnv } from "@ustal/config";
import type { MediaStorageProvider } from "./types.js";
import { createLocalDiskStorage } from "./providers/local-disk.js";
import { s3Storage } from "./providers/s3.js";

export * from "./types.js";

let cached: MediaStorageProvider | undefined;

/** Единая точка получения провайдера — читает MEDIA_STORAGE_PROVIDER из конфигурации. */
export function getMediaStorage(): MediaStorageProvider {
  if (cached) return cached;
  const env = loadEnv();
  cached = env.MEDIA_STORAGE_PROVIDER === "s3" ? s3Storage : createLocalDiskStorage(env.MEDIA_LOCAL_DIR);
  return cached;
}
