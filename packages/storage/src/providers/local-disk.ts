import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaStorageProvider } from "../types.js";

/**
 * Хранилище для локальной разработки/тестов: пишет файлы на диск процесса
 * api. НЕ для продакшена (не переживёт передеплой/несколько инстансов) —
 * см. providers/s3.ts, который заменяет его через MEDIA_STORAGE_PROVIDER=s3
 * без изменения вызывающего кода (тот же принцип, что и MockAIProvider).
 */
export function createLocalDiskStorage(baseDir: string): MediaStorageProvider {
  return {
    name: "local",
    async upload({ buffer, ownerId, kind, mimeType }) {
      const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
      const key = `${kind}/${ownerId}/${randomUUID()}.${ext}`;
      const fullPath = path.join(baseDir, key);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, buffer);
      return { storageKey: key };
    },
    resolvePath(storageKey: string) {
      return path.join(baseDir, storageKey);
    },
  };
}
