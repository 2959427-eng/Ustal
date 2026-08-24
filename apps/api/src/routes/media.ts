import type { FastifyInstance } from "fastify";
import { getDb, schema } from "@ustal/database";
import { getMediaStorage } from "@ustal/storage";
import { MEDIA_LIMITS, mediaKindSchema } from "@ustal/validation";

/**
 * POST /media — единая точка загрузки фото/аудио (docs/api.md, «Медиа и
 * жалобы»). Используется и профилем (голосовой ввод), и заказами (фото,
 * голос) — см. docs/architecture.md, добавление #10. Multipart-поля
 * читаются через request.parts(), а не request.file(), чтобы не зависеть от
 * порядка полей "kind"/"file" в форме, который мобильный клиент не
 * гарантирует.
 */
export default async function mediaRoutes(app: FastifyInstance) {
  const db = getDb();
  const storage = getMediaStorage();

  app.post("/media", { preHandler: app.authenticate }, async (request, reply) => {
    let kindValue: string | undefined;
    let fileBuffer: Buffer | undefined;
    let mimeType: string | undefined;

    for await (const part of request.parts()) {
      if (part.type === "file") {
        fileBuffer = await part.toBuffer();
        mimeType = part.mimetype;
      } else if (part.fieldname === "kind") {
        kindValue = String(part.value);
      }
    }

    if (!fileBuffer || !mimeType) {
      return reply.code(400).send({ error: { code: "file_required", message: "Ожидается multipart-поле file" } });
    }

    const kindParsed = mediaKindSchema.safeParse(kindValue);
    if (!kindParsed.success) {
      return reply
        .code(400)
        .send({ error: { code: "invalid_kind", message: "Поле kind должно быть photo или audio" } });
    }
    const kind = kindParsed.data;
    const limits = MEDIA_LIMITS[kind];

    if (!(limits.mimeTypes as readonly string[]).includes(mimeType)) {
      return reply
        .code(400)
        .send({ error: { code: "invalid_mime_type", message: `Недопустимый тип файла для ${kind}: ${mimeType}` } });
    }
    if (fileBuffer.byteLength > limits.maxBytes) {
      return reply
        .code(400)
        .send({ error: { code: "file_too_large", message: `Файл больше ${limits.maxBytes} байт` } });
    }

    const stored = await storage.upload({ buffer: fileBuffer, ownerId: request.userId, kind, mimeType });
    const [row] = await db
      .insert(schema.media)
      .values({
        ownerId: request.userId,
        kind,
        storageProvider: storage.name,
        storageKey: stored.storageKey,
        mimeType,
        sizeBytes: fileBuffer.byteLength,
      })
      .returning();
    if (!row) throw new Error("Failed to persist media");

    return reply.code(201).send({ mediaId: row.id });
  });
}
