import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { MediaStorageProvider } from "../types.js";

/**
 * Timeweb Cloud Object Storage (S3-совместимое) — см. OBJECT_STORAGE_* в
 * packages/config. Реализовано в Фазе 8 (найдено при подключении боевых
 * credentials — до этого была заготовка Фазы 2, см. architecture.md §5):
 * `@aws-sdk/client-s3` работает с любым S3-совместимым эндпоинтом, включая
 * Timeweb Cloud, если передать его `OBJECT_STORAGE_ENDPOINT` и
 * `forcePathStyle: true` (нужно почти всем не-AWS S3-совместимым провайдерам
 * — виртуальный hosted-style `bucket.endpoint.com` у них обычно не настроен).
 *
 * `resolvePath` возвращает presigned GET URL (короткоживущий, без публичного
 * доступа к бакету), а не физический локальный путь — единственное отличие
 * контракта между local- и s3-провайдером, которое видит вызывающий код
 * (worker передаёт результат в STT-провайдер как `filePath`; `openAiStt`
 * умеет читать и обычный путь на диске, и `http(s)://` URL — см.
 * packages/ai/src/providers/openai.ts).
 */
export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Регион не имеет значения для большинства S3-совместимых провайдеров, но SDK требует непустую строку. */
  region?: string;
  /** Время жизни presigned URL, секунды. */
  urlExpirySeconds?: number;
}

export function createS3Storage(config: S3StorageConfig): MediaStorageProvider {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const urlExpirySeconds = config.urlExpirySeconds ?? 900; // 15 минут — достаточно для немедленного чтения worker'ом

  return {
    name: "s3",
    async upload({ buffer, ownerId, kind, mimeType }) {
      const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
      const key = `${kind}/${ownerId}/${randomUUID()}.${ext}`;
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        }),
      );
      return { storageKey: key };
    },
    async resolvePath(storageKey: string) {
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: storageKey });
      return getSignedUrl(client, command, { expiresIn: urlExpirySeconds });
    },
  };
}
