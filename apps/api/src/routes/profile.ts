import { diffByNode, diffUnmapped, pickRestrictions, pickUnmappedFacts, withItemAttributes } from "../lib/profile-diff.js";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getRuntimeConfig } from "@ustal/config";
import { getBoss, JOB_TYPES, PROFILE_INPUT_RECOVERY_WINDOW_HOURS, profileExtractionJobOptions, profileTranscribeJobOptions } from "@ustal/queue";
import {
  editTranscriptSchema,
  profileFactSourceParamSchema,
  profileInputSchema,
  updateProfileSchema,
} from "@ustal/validation";
import { withIdempotency } from "../lib/idempotency.js";
import { enqueueProfileFacts } from "../lib/profile-facts.js";
import { revokeProfileSourceInput } from "../lib/source-revoke.js";
import { applyProfileItemAction, ITEM_ACTIONS, ITEM_KINDS, loadRemovedItems, type ItemAction, type ItemKind } from "../lib/profile-items.js";

/**
 * Постановка задачи по сообщению профиля (QA 2026-10-14, дефект №2). Сообщение к этому моменту уже
 * сохранено в БД, поэтому сбой очереди не превращается в 500: клиент получает обычный 202, а задачу
 * поставит восстановление застрявших сообщений в worker (profile-input-recovery.ts). Иначе повтор
 * клиента создал бы второй экземпляр того же сообщения.
 */
async function enqueueProfileJob(sourceInputId: string, enqueue: () => Promise<unknown>) {
  try {
    await enqueue();
  } catch (error) {
    console.error(JSON.stringify({ event: "profile_job_enqueue_failed", sourceInputId,
      error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Профиль возможностей (docs/api.md, docs/matching.md пайплайн профиля).
 * `capability_profiles` — append-only: каждая AI-правка создаёт новую версию,
 * а не перезаписывает старую (docs/data-model.md). `PATCH /profile` — точечные
 * правки без AI (город, имя, WhatsApp), не версионируется отдельно и не
 * требует Idempotency-Key.
 *
 * Две паузы AI-пайплайна (claude/pipeline-split-design.md):
 * - «Проверка транскрипции» (экран 9) — `profile_source_inputs.status`,
 *   POST/GET/PATCH `/profile/inputs/{id}`, POST `/profile/inputs/{id}/confirm`.
 * - «Подтверждение изменений» (экран 10) — `capability_profiles.status`,
 *   GET `/profile/draft`, POST `/profile/draft/{id}/apply`|`/discard`.
 *   `GET /profile` теперь отдаёт только status='applied'.
 */
export default async function profileRoutes(app: FastifyInstance) {
  const db = getDb();

  /** Фразы последнего matching-документа профиля, не сопоставленные с онтологией. */
  /** Явные ограничения из фактов последнего matching-документа профиля (только чтение). */
  async function loadRestrictions(profileId: string) {
    const doc = await db.query.matchingDocuments.findFirst({
      where: eq(schema.matchingDocuments.profileId, profileId),
      orderBy: desc(schema.matchingDocuments.processedAt),
    });
    if (!doc) return [];
    const facts = await db.query.matchingFacts.findMany({
      where: eq(schema.matchingFacts.documentId, doc.id),
    });
    return pickRestrictions(facts);
  }

  /**
   * Обрабатывается ли сохранённое сообщение (mobile QA 2026-10-14, M11): подтверждённое, не отозванное,
   * без версии профиля (кроме invalidated), в окне автоматического восстановления и не исчерпавшее
   * лимит неудач. Источник — сервер, а не память приложения: после перезапуска клиент продолжает ждать.
   */
  async function loadProcessingState(userId: string): Promise<{ processing: boolean; processingSince: string | null }> {
    const rows = (await db.execute(sql`
      select min(psi.created_at) as since
      from profile_source_inputs psi
      left join profile_input_recovery r on r.source_input_id = psi.id and r.stage = 'extraction'
      where psi.user_id = ${userId} and psi.status = 'confirmed' and psi.revoked_at is null
        and psi.created_at > now() - make_interval(hours => ${PROFILE_INPUT_RECOVERY_WINDOW_HOURS})
        and r.state is distinct from 'exhausted'
        and not exists (select 1 from capability_profiles cp
          where cp.source_input_id = psi.id and cp.status <> 'invalidated')`)) as unknown as Array<{ since: Date | string | null }>;
    const since = rows[0]?.since ?? null;
    return { processing: since !== null, processingSince: since === null ? null : new Date(since).toISOString() };
  }

  /** Факты последнего matching-документа профиля (только чтение). */
  async function loadProfileFacts(profileId: string) {
    const doc = await db.query.matchingDocuments.findFirst({
      where: eq(schema.matchingDocuments.profileId, profileId),
      orderBy: desc(schema.matchingDocuments.processedAt),
    });
    if (!doc) return [];
    return db.query.matchingFacts.findMany({
      where: eq(schema.matchingFacts.documentId, doc.id),
    });
  }

  async function loadAppliedProfile(userId: string) {
    const latest = await db.query.capabilityProfiles.findFirst({
      where: and(
        eq(schema.capabilityProfiles.userId, userId),
        eq(schema.capabilityProfiles.status, "applied"),
      ),
      orderBy: desc(schema.capabilityProfiles.profileVersion),
    });
    if (!latest) return null;

    const [capabilities, resourceRows] = await Promise.all([
      db.query.userCapabilities.findMany({
        where: eq(schema.userCapabilities.capabilityProfileId, latest.id),
      }),
      db.query.userResources.findMany({
        where: eq(schema.userResources.capabilityProfileId, latest.id),
      }),
    ]);

    const facts = await loadProfileFacts(latest.id);
    const resources = withItemAttributes(resourceRows, facts);
    const unmapped = pickUnmappedFacts(facts, [...capabilities, ...resources].map((i) => i.label));
    const restrictions = await loadRestrictions(latest.id);
    // Убранные кнопкой пункты (2026-10-17) — для «Восстановить»; снятое AI-сообщением сюда не входит.
    const removed = await loadRemovedItems(db, userId, facts);

    return {
      profile: {
        id: latest.id,
        summary: latest.summary,
        profileVersion: latest.profileVersion,
        extractionVersion: latest.extractionVersion,
        createdAt: latest.createdAt,
      },
      capabilities,
      resources,
      unmapped,
      restrictions,
      removed,
    };
  }

  app.get(
    "/profile",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const result = await loadAppliedProfile(request.userId);
      // Source revoke: while the profile is rebuilt from the remaining messages the old version (which
      // still contains the revoked one) is neither shown nor used by matching.
      const rebuilding = !!(await db.query.capabilityProfiles.findFirst({
        where: and(
          eq(schema.capabilityProfiles.userId, request.userId),
          eq(schema.capabilityProfiles.status, "rebuild_pending"),
        ),
      }));
      return reply.send({
        ...(result ?? { profile: null, capabilities: [], resources: [], unmapped: [], restrictions: [] }),
        rebuilding,
      });
    },
  );

  app.patch(
    "/profile",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = updateProfileSchema.parse(request.body);

      // Фото профиля (аватарка, экран «Личный кабинет») — тот же mediaId,
      // что возвращает POST /media (kind: "photo"), см. routes/media.ts.
      // Проверка владения — тот же паттерн, что и audioMediaId в
      // POST /profile/inputs выше: чужой/несуществующий/не-photo id не
      // должен молча привязаться к профилю.
      if (body.avatarMediaId) {
        const owned = await db.query.media.findFirst({
          where: and(
            eq(schema.media.id, body.avatarMediaId),
            eq(schema.media.ownerId, request.userId),
          ),
        });
        if (!owned || owned.kind !== "photo") {
          return reply.code(400).send({
            error: {
              code: "media_not_found",
              message:
                "avatarMediaId не найден, не является фото или принадлежит другому пользователю",
            },
          });
        }
      }

      const updates: Partial<typeof schema.userProfiles.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (body.name !== undefined) updates.name = body.name;
      if (body.cityId !== undefined) updates.cityId = body.cityId;
      if (body.whatsappPhone !== undefined)
        updates.whatsappPhone = body.whatsappPhone;
      if (body.avatarMediaId !== undefined)
        updates.avatarMediaId = body.avatarMediaId;
      if (body.about !== undefined) updates.about = body.about ? body.about : null;

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.userProfiles)
          .set(updates)
          .where(eq(schema.userProfiles.userId, request.userId))
          .returning();
        if (row && body.cityId !== undefined)
          await tx
            .insert(schema.rematchRequests)
            .values({ userId: request.userId })
            .onConflictDoUpdate({
              target: schema.rematchRequests.userId,
              set: { requestedAt: sql`now()`, cursor: null },
            });
        return row;
      });

      if (!updated) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Профиль не найден" } });
      }
      return reply.send({
        name: updated.name,
        cityId: updated.cityId,
        whatsappPhone: updated.whatsappPhone,
        avatarMediaId: updated.avatarMediaId,
        about: updated.about,
      });
    },
  );

  app.post(
    "/profile/inputs",
    { preHandler: app.authenticate },
    async (request, reply) => {
      await withIdempotency(
        request,
        reply,
        "POST /profile/inputs",
        async (): Promise<{
          status: number;
          body: Record<string, unknown>;
        }> => {
          const body = profileInputSchema.parse(request.body);

          const config = getRuntimeConfig();
          const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

          // Security-фикс (2026-09-22): тот же класс гонки, что и в POST /orders
          // (routes/orders.ts) — count (PROFILE_FREEFORM_EDITS_PER_HOUR) и insert
          // раньше шли отдельными запросами вне транзакции. pg_advisory_xact_lock
          // по userId сериализует конкурентные запросы одного пользователя.
          let rateLimited = false;
          let mediaInvalid = false;
          const input = await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${request.userId}))`);

            const recentInputs = await tx.query.profileSourceInputs.findMany({
              where: and(
                eq(schema.profileSourceInputs.userId, request.userId),
                gt(schema.profileSourceInputs.createdAt, hourAgo),
              ),
            });
            if (
              recentInputs.length >= config.rateLimits.profileFreeformEditsPerHour
            ) {
              rateLimited = true;
              return undefined;
            }

            if (body.inputType === "voice" && body.audioMediaId) {
              const owned = await tx.query.media.findFirst({
                where: and(
                  eq(schema.media.id, body.audioMediaId),
                  eq(schema.media.ownerId, request.userId),
                ),
              });
              if (!owned) {
                mediaInvalid = true;
                return undefined;
              }
            }

            // Пауза «Проверка транскрипции» (экран 9): voice-ввод сначала уходит
            // только на STT (PROFILE_TRANSCRIBE) и ждёт подтверждения — text-ввод
            // нечего разделять, правка уже произошла в композере, сразу extraction.
            const [row] = await tx
              .insert(schema.profileSourceInputs)
              .values({
                userId: request.userId,
                inputType: body.inputType,
                rawText: body.inputType === "text" ? (body.text ?? null) : null,
                audioMediaId:
                  body.inputType === "voice" ? (body.audioMediaId ?? null) : null,
                status: body.inputType === "voice" ? "transcribing" : "confirmed",
              })
              .returning();
            return row;
          });
          if (rateLimited) {
            return {
              status: 429 as const,
              body: {
                error: {
                  code: "rate_limited",
                  message: `Не более ${config.rateLimits.profileFreeformEditsPerHour} правок профиля в час`,
                },
              },
            };
          }
          if (mediaInvalid) {
            return {
              status: 400 as const,
              body: {
                error: {
                  code: "media_not_found",
                  message:
                    "audioMediaId не найден или принадлежит другому пользователю",
                },
              },
            };
          }
          if (!input)
            throw new Error("Failed to create profile_source_inputs row");

          if (body.inputType === "voice") {
            await enqueueProfileJob(input.id, async () => (await getBoss()).send(JOB_TYPES.PROFILE_TRANSCRIBE, {
              sourceInputId: input.id,
            }, profileTranscribeJobOptions(input.id)));
            return {
              status: 202 as const,
              body: {
                sourceInputId: input.id,
                status: "transcribing" as const,
              },
            };
          }

          await enqueueProfileJob(input.id, async () => {
            const boss = await getBoss();
            await boss.send(JOB_TYPES.PROFILE_EXTRACTION, {
              userId: request.userId,
              sourceInputId: input.id,
            }, profileExtractionJobOptions(input.id));
            await enqueueProfileFacts(boss, { userId: request.userId, sourceInputId: input.id });
          });
          return {
            status: 202 as const,
            body: { sourceInputId: input.id, status: "processing" as const },
          };
        },
      );
    },
  );

  app.get(
    "/profile/inputs/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = await db.query.profileSourceInputs.findFirst({
        where: eq(schema.profileSourceInputs.id, id),
      });
      if (!input || input.userId !== request.userId) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Ввод не найден" } });
      }
      return reply.send({
        id: input.id,
        inputType: input.inputType,
        status: input.status,
        transcript: input.transcript,
        transcriptCorrected: input.transcriptCorrected,
        createdAt: input.createdAt,
        revokedAt: input.revokedAt,
      });
    },
  );

  /**
   * Revoke one of MY messages from the profile (2026-09-28): facts revoked, never used in any future
   * AI-profile build; if the current profile contains it, it leaves matching at once and is rebuilt from
   * the remaining messages (profileRebuild: "pending"). See lib/source-revoke.ts. Idempotent.
   */
  /**
   * Direct revoke/restore пункта профиля без AI (2026-10-17): «Убрать» навык/ресурс (нейтрально, не отказ),
   * «Снять ограничение», «Восстановить». Без тела запроса; лимит AI-сообщений не тратится. См. lib/profile-items.ts.
   */
  app.post(
    "/profile/items/:kind/:id/:action",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { kind, id, action } = request.params as { kind: string; id: string; action: string };
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!ITEM_KINDS.includes(kind as ItemKind) || !ITEM_ACTIONS.includes(action as ItemAction) || !uuid.test(id))
        return reply.code(404).send({ error: { code: "not_found", message: "Пункт профиля не найден" } });
      const result = await applyProfileItemAction(db, { userId: request.userId, kind: kind as ItemKind, id, action: action as ItemAction });
      if (result.status === 200 && result.refreshEmbedding) {
        // Векторы профиля пересчитывает worker (1 вызов embedding, не extraction). Версия уже помечена embedding_stale в
        // транзакции (matching не использует устаревший вектор); при сбое постановки задачу поставит диспетчер worker.
        try {
          const boss = await getBoss();
          await boss.send(JOB_TYPES.PROFILE_EMBEDDING_REFRESH, { userId: request.userId },
            { retryLimit: 4, retryDelay: 5, retryBackoff: true, singletonKey: `profile-embedding:${request.userId}` });
        } catch (error) {
          request.log.warn({ err: error }, "profile embedding refresh enqueue failed; the worker dispatcher will pick it up");
        }
      }
      return reply.code(result.status).send(result.body);
    },
  );

  app.delete(
    "/profile/inputs/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const p = profileFactSourceParamSchema.safeParse({ sourceInputId: (request.params as { id: string }).id });
      const result = p.success ? await revokeProfileSourceInput(request.userId, p.data.sourceInputId) : null;
      if (!result)
        return reply.code(404).send({ error: { code: "not_found", message: "Ввод не найден" } });
      return reply.code(202).send({ sourceInputId: p.data!.sourceInputId, status: "revoked" as const, ...result });
    },
  );

  app.patch(
    "/profile/inputs/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = editTranscriptSchema.parse(request.body);

      const input = await db.query.profileSourceInputs.findFirst({
        where: eq(schema.profileSourceInputs.id, id),
      });
      if (!input || input.userId !== request.userId) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Ввод не найден" } });
      }
      if (input.status !== "awaiting_review" || input.revokedAt) {
        return reply.code(409).send({
          error: {
            code: "invalid_status",
            message: input.revokedAt
              ? "Сообщение отозвано"
              : `Транскрипт нельзя редактировать в статусе "${input.status}"`,
          },
        });
      }

      const [updated] = await db
        .update(schema.profileSourceInputs)
        .set({ transcriptCorrected: body.transcriptCorrected })
        .where(eq(schema.profileSourceInputs.id, id))
        .returning();
      return reply.send({
        id: updated!.id,
        transcript: updated!.transcript,
        transcriptCorrected: updated!.transcriptCorrected,
      });
    },
  );

  app.post(
    "/profile/inputs/:id/confirm",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await withIdempotency(
        request,
        reply,
        "POST /profile/inputs/:id/confirm",
        async (): Promise<{
          status: number;
          body: Record<string, unknown>;
        }> => {
          const input = await db.query.profileSourceInputs.findFirst({
            where: eq(schema.profileSourceInputs.id, id),
          });
          if (!input || input.userId !== request.userId) {
            return {
              status: 404 as const,
              body: { error: { code: "not_found", message: "Ввод не найден" } },
            };
          }
          if (input.status !== "awaiting_review" || input.revokedAt) {
            return {
              status: 409 as const,
              body: {
                error: {
                  code: "invalid_status",
                  message: input.revokedAt
                    ? "Сообщение отозвано"
                    : `Нельзя подтвердить транскрипт в статусе "${input.status}"`,
                },
              },
            };
          }

          await db
            .update(schema.profileSourceInputs)
            .set({ status: "confirmed" })
            .where(eq(schema.profileSourceInputs.id, id));

          await enqueueProfileJob(input.id, async () => {
            const boss = await getBoss();
            await boss.send(JOB_TYPES.PROFILE_EXTRACTION, {
              userId: request.userId,
              sourceInputId: input.id,
            }, profileExtractionJobOptions(input.id));
            await enqueueProfileFacts(boss, { userId: request.userId, sourceInputId: input.id });
          });

          return {
            status: 202 as const,
            body: { sourceInputId: input.id, status: "processing" as const },
          };
        },
      );
    },
  );

  app.get(
    "/profile/draft",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const draft = await db.query.capabilityProfiles.findFirst({
        where: and(
          eq(schema.capabilityProfiles.userId, request.userId),
          eq(schema.capabilityProfiles.status, "draft"),
        ),
        orderBy: desc(schema.capabilityProfiles.profileVersion),
      });
      const processingState = await loadProcessingState(request.userId);
      if (!draft) return reply.send({ draft: null, ...processingState });

      const [draftCapabilities, draftResources, appliedResult] =
        await Promise.all([
          db.query.userCapabilities.findMany({
            where: eq(schema.userCapabilities.capabilityProfileId, draft.id),
          }),
          db.query.userResources.findMany({
            where: eq(schema.userResources.capabilityProfileId, draft.id),
          }),
          loadAppliedProfile(request.userId),
        ]);

      // Older pending drafts must not reappear after a newer version was applied.
      if (appliedResult && appliedResult.profile.profileVersion >= draft.profileVersion)
        return reply.send({ draft: null, ...processingState });

      // Экран 10 ТЗ: «подтверждения удаления значимых пунктов» — дифф считаем
      // здесь, ДО применения, а не постфактум на клиенте (был временный
      // компромисс в slice 7 этой ветки, теперь заменяется этим эндпоинтом).
      const capDiff = diffByNode(appliedResult?.capabilities ?? [], draftCapabilities);
      const resDiff = diffByNode(appliedResult?.resources ?? [], draftResources);
      const draftFacts = await loadProfileFacts(draft.id);
      const draftUnmapped = pickUnmappedFacts(draftFacts, [...draftCapabilities, ...draftResources].map((i) => i.label));

      return reply.send({
        draft: {
          id: draft.id,
          summary: draft.summary,
          profileVersion: draft.profileVersion,
          createdAt: draft.createdAt,
        },
        capabilities: draftCapabilities,
        resources: withItemAttributes(draftResources, draftFacts),
        unmapped: draftUnmapped,
        diff: {
          addedCapabilities: capDiff.added,
          removedCapabilities: capDiff.removed,
          addedResources: resDiff.added,
          removedResources: resDiff.removed,
          addedUnmapped: diffUnmapped(appliedResult?.unmapped ?? [], draftUnmapped),
        },
        ...processingState,
      });
    },
  );

  app.post(
    "/profile/draft/:id/apply",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const draft = await db.query.capabilityProfiles.findFirst({
        where: eq(schema.capabilityProfiles.id, id),
      });
      if (!draft || draft.userId !== request.userId) {
        return reply
          .code(404)
          .send({
            error: { code: "not_found", message: "Черновик не найден" },
          });
      }
      if (draft.status !== "draft") {
        return reply.code(409).send({
          error: {
            code: "invalid_status",
            message: `Нельзя применить черновик в статусе "${draft.status}"`,
          },
        });
      }

      const applied = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${request.userId},0))`,
        );
        const current = await tx.query.capabilityProfiles.findFirst({
          where: eq(schema.capabilityProfiles.id, id),
        });
        if (current?.status !== "draft") return false;
        const newerApplied = await tx.query.capabilityProfiles.findFirst({
          where: and(
            eq(schema.capabilityProfiles.userId, request.userId),
            eq(schema.capabilityProfiles.status, "applied"),
            gt(schema.capabilityProfiles.profileVersion, current.profileVersion),
          ),
        });
        if (newerApplied) return false;
        // Source revoke: a rebuild is pending, so every draft is based on text with a revoked message.
        const rebuildPending = await tx.query.capabilityProfiles.findFirst({
          where: and(
            eq(schema.capabilityProfiles.userId, request.userId),
            eq(schema.capabilityProfiles.status, "rebuild_pending"),
          ),
        });
        if (rebuildPending) return false;
        await tx
          .update(schema.capabilityProfiles)
          .set({ status: "superseded" })
          .where(
            and(
              eq(schema.capabilityProfiles.userId, request.userId),
              eq(schema.capabilityProfiles.status, "applied"),
            ),
          );
        await tx
          .update(schema.capabilityProfiles)
          .set({ status: "applied" })
          .where(eq(schema.capabilityProfiles.id, id));
        await tx
          .update(schema.capabilityProfiles)
          .set({ status: "superseded" })
          .where(and(
            eq(schema.capabilityProfiles.userId, request.userId),
            eq(schema.capabilityProfiles.status, "draft"),
            lt(schema.capabilityProfiles.profileVersion, current.profileVersion),
          ));
        await tx
          .insert(schema.rematchRequests)
          .values({ userId: request.userId })
          .onConflictDoUpdate({
            target: schema.rematchRequests.userId,
            set: { requestedAt: sql`now()`, cursor: null },
          });
        return true;
      });

      if (!applied) return reply.code(409).send({
        error: { code: "stale_draft", message: "Черновик устарел. Обновите профиль." },
      });
      return reply.send({ profileId: draft.id, status: "applied" as const });
    },
  );

  app.post(
    "/profile/draft/:id/discard",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const draft = await db.query.capabilityProfiles.findFirst({
        where: eq(schema.capabilityProfiles.id, id),
      });
      if (!draft || draft.userId !== request.userId) {
        return reply
          .code(404)
          .send({
            error: { code: "not_found", message: "Черновик не найден" },
          });
      }
      if (draft.status !== "draft") {
        return reply.code(409).send({
          error: {
            code: "invalid_status",
            message: `Нельзя отклонить черновик в статусе "${draft.status}"`,
          },
        });
      }
      const discarded = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${request.userId},0))`);
        const current = await tx.query.capabilityProfiles.findFirst({
          where: eq(schema.capabilityProfiles.id, id),
        });
        if (current?.status !== "draft") return false;
        await tx.update(schema.capabilityProfiles).set({ status: "discarded" })
          .where(eq(schema.capabilityProfiles.id, id));
        // Later cumulative drafts include this proposal. They must be rebuilt
        // without the rejected input; the worker's durable dispatcher picks them up.
        await tx.update(schema.capabilityProfiles).set({ status: "invalidated" })
          .where(and(eq(schema.capabilityProfiles.userId, request.userId),
            eq(schema.capabilityProfiles.status, "draft"),
            gt(schema.capabilityProfiles.profileVersion, current.profileVersion)));
        return true;
      });
      if (!discarded) return reply.code(409).send({
        error: { code: "stale_draft", message: "Черновик устарел. Обновите профиль." },
      });
      return reply.code(204).send();
    },
  );

  app.get(
    "/profile/preferences",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const preferences = await db.query.learnedPreferences.findMany({
        where: and(
          eq(schema.learnedPreferences.userId, request.userId),
          isNull(schema.learnedPreferences.revokedAt),
        ),
      });

      // Раздел 27 ТЗ: «управление learned_preferences — отмена "не показывать
      // подобное"» — экран должен показать ЧТО пользователь скрыл, а не
      // голый ontologyNodeId. nameRu подтягивается тем же паттерном, что и
      // остальные join'ы по спискам в этом API.
      const nodeIds = [...new Set(preferences.map((p) => p.ontologyNodeId))];
      const nodes =
        nodeIds.length > 0
          ? await db.query.ontologyNodes.findMany({
              where: (t, { inArray }) => inArray(t.id, nodeIds),
            })
          : [];
      const nameByNodeId = new Map(nodes.map((n) => [n.id, n.nameRu]));

      return reply.send(
        preferences.map((p) => ({
          id: p.id,
          ontologyNodeId: p.ontologyNodeId,
          ontologyNodeName: nameByNodeId.get(p.ontologyNodeId) ?? null,
          signal: p.signal,
          source: p.source,
          weight: p.weight,
          createdAt: p.createdAt,
        })),
      );
    },
  );

  app.delete(
    "/profile/preferences/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const existing = await db.query.learnedPreferences.findFirst({
        where: eq(schema.learnedPreferences.id, id),
      });
      if (!existing || existing.userId !== request.userId) {
        return reply
          .code(404)
          .send({
            error: { code: "not_found", message: "Предпочтение не найдено" },
          });
      }
      await db
        .update(schema.learnedPreferences)
        .set({ revokedAt: new Date() })
        .where(eq(schema.learnedPreferences.id, id));
      return reply.code(204).send();
    },
  );
}
