import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
    cleanupIdentity: `local:${createHash("sha256").update(path.resolve(baseDir)).digest("hex")}`,
    async upload({ buffer, ownerId, kind, mimeType }) {
      const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
      const key = `${kind}/${ownerId}/${randomUUID()}.${ext}`;
      const fullPath = path.join(baseDir, key);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, buffer);
      return { storageKey: key };
    },
    async resolvePath(storageKey: string) {
      return path.join(baseDir, storageKey);
    },
    async remove(storageKey: string) {
      const base = path.resolve(baseDir);
      const fullPath = path.resolve(base, storageKey);
      // Ключи всегда относительные (kind/owner/uuid.ext); путь вне каталога медиа не удаляем никогда.
      if (!fullPath.startsWith(base + path.sep)) throw new Error("Invalid storage key");
      await rm(fullPath, { force: true });
    },
  };
}
