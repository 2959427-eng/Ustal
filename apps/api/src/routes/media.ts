import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getRuntimeConfig } from "@ustal/config";
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

// Раньше проверялся только заявленный клиентом Content-Type (part.mimetype) —
// его легко подделать, назвав что угодно "image/jpeg". Полноценный whitelist
// по сигнатуре реального контента рискует ложно отклонить валидные, но менее
// типичные варианты кодирования настоящих фото/аудио (а это сломало бы
// загрузку у реальных пользователей — как раз то, что нельзя допустить).
// Вместо этого — blacklist по сигнатурам заведомо опасного контента
// (исполняемые файлы, скрипты, архивы) — ловит попытку загрузить что-то
// явно не медиа под чужой маской, не рискуя отклонить настоящее фото/аудио.
const DANGEROUS_SIGNATURES: { bytes: number[]; label: string }[] = [
  { bytes: [0x4d, 0x5a], label: "исполняемый файл Windows (MZ/PE)" },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: "исполняемый файл Linux (ELF)" },
  { bytes: [0x23, 0x21], label: "скрипт (#!)" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], label: "zip/офисный архив (PK)" },
  { bytes: [0x3c, 0x3f, 0x70, 0x68, 0x70], label: "PHP-скрипт (<?php)" },
];

function detectDangerousSignature(buffer: Buffer): string | null {
  for (const sig of DANGEROUS_SIGNATURES) {
    if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
      return sig.label;
    }
  }
  return null;
}

export default async function mediaRoutes(app: FastifyInstance) {
  const db = getDb();
  const storage = getMediaStorage();

  app.post("/media", { preHandler: app.authenticate }, async (request, reply) => {
    // Анти-abuse: без лимита /media можно гонять в цикле сколько угодно раз в минуту
    // (под общим 100/мин на IP, который делится на все эндпоинты сразу) — каждый
    // запрос буферизует файл в памяти и пишет на диск/в object storage. Проверяем
    // ДО чтения тела запроса, чтобы не тратить память/диск на заведомо отклонённую загрузку.
    const config = getRuntimeConfig();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [recentUploadsRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.media)
      .where(and(eq(schema.media.ownerId, request.userId), gt(schema.media.createdAt, hourAgo)));
    if ((recentUploadsRow?.n ?? 0) >= config.rateLimits.mediaUploadsPerHour) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: `Не более ${config.rateLimits.mediaUploadsPerHour} загрузок в час` },
      });
    }

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

    const dangerous = detectDangerousSignature(fileBuffer);
    if (dangerous) {
      return reply.code(400).send({
        error: { code: "invalid_file_content", message: `Содержимое файла похоже на ${dangerous}, а не на ${kind}` },
      });
    }

    // Загрузка в storage — сетевой I/O (особенно у s3-провайдера), поэтому не
    // держим её внутри БД-транзакции/advisory lock ниже (заняла бы соединение
    // из пула на всё время внешнего запроса). Ранняя проверка выше — только
    // fast-path оптимизация; авторитетная проверка обоих лимитов — атомарно,
    // непосредственно перед insert, см. ниже.
    const stored = await storage.upload({ buffer: fileBuffer, ownerId: request.userId, kind, mimeType });

    // Security-фикс (2026-09-22): count/sum (MEDIA_UPLOADS_PER_HOUR и
    // storage-квота) и insert раньше шли отдельными запросами вне транзакции —
    // тот же класс гонки, что и в POST /orders (routes/orders.ts). Финальная
    // проверка обоих лимитов и insert — атомарно под pg_advisory_xact_lock по
    // userId; ранняя проверка выше (до чтения тела запроса) остаётся как
    // fast-path оптимизация и не единственная защита.
    let rateLimited = false;
    let quotaExceeded = false;
    // Файл уже в хранилище: если строка не сохранится (лимит, квота, удалённый аккаунт — триггер 0026, любая
    // ошибка), файл удаляется, чтобы не оставалось личных данных без владельца.
    const discard = () => storage.remove(stored.storageKey).catch(() => request.log.warn("media: orphan file removal failed"));
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${request.userId}))`);

      const [recentUploadsRow2] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.media)
        .where(and(eq(schema.media.ownerId, request.userId), gt(schema.media.createdAt, hourAgo)));
      if ((recentUploadsRow2?.n ?? 0) >= config.rateLimits.mediaUploadsPerHour) {
        rateLimited = true;
        return undefined;
      }

      const [usedBytesRow] = await tx
        .select({ total: sql<string>`coalesce(sum(${schema.media.sizeBytes}), 0)` })
        .from(schema.media)
        .where(eq(schema.media.ownerId, request.userId));
      const usedBytes = Number(usedBytesRow?.total ?? 0);
      if (usedBytes + fileBuffer.byteLength > config.rateLimits.mediaStorageMaxBytesPerUser) {
        quotaExceeded = true;
        return undefined;
      }

      const [inserted] = await tx
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
      return inserted;
    }).catch(async (error) => { await discard(); throw error; });
    if (!row) await discard();
    if (rateLimited) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: `Не более ${config.rateLimits.mediaUploadsPerHour} загрузок в час` },
      });
    }
    if (quotaExceeded) {
      return reply.code(400).send({
        error: {
          code: "storage_quota_exceeded",
          message: `Превышен лимит хранения файлов (${config.rateLimits.mediaStorageMaxBytesPerUser} байт на пользователя)`,
        },
      });
    }
    if (!row) throw new Error("Failed to persist media");

    return reply.code(201).send({ mediaId: row.id });
  });

  /**
   * GET /media/{id} — отдаёт содержимое загруженного файла обратно клиенту.
   * До этого POST /media использовался только worker'ом (STT читает файл
   * через storage.resolvePath на сервере) — отдать файл наружу было нечем,
   * а аватарке профиля (и в перспективе фото заказа) нужен URL для
   * <Image source={{uri}}>.
   *
   * Фото отдаём БЕЗ access token по непредсказуемому UUID — тот же уровень
   * защиты, что и presigned URL у s3-провайдера (providers/s3.ts: секрет в
   * самой ссылке, а не в сессии), иначе пришлось бы прокидывать
   * Authorization в заголовки каждого <Image> в React Native. Аудио
   * (голосовые вводы профиля/заказа) — приватное, отдаём только владельцу.
   */
  app.get("/media/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const media = await db.query.media.findFirst({ where: eq(schema.media.id, id) });
    if (!media) {
      return reply.code(404).send({ error: { code: "not_found", message: "Файл не найден" } });
    }

    if (media.kind !== "photo") {
      await app.authenticate(request, reply);
      if (reply.sent) return;
      if (media.ownerId !== request.userId) {
        return reply.code(404).send({ error: { code: "not_found", message: "Файл не найден" } });
      }
    }

    const resolved = await storage.resolvePath(media.storageKey);
    if (storage.name === "s3") {
      // resolvePath уже вернул presigned GET URL — редиректим на него.
      return reply.redirect(resolved);
    }
    // local: resolvePath вернул путь на диске процесса api — стримим файл сами.
    reply.type(media.mimeType);
    return reply.send(createReadStream(resolved));
  });
}
