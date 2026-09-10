import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getRuntimeConfig } from "@ustal/config";
import { getBoss, JOB_TYPES } from "@ustal/queue";
import { editTranscriptSchema, profileInputSchema, updateProfileSchema } from "@ustal/validation";
import { withIdempotency } from "../lib/idempotency.js";

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

  async function loadAppliedProfile(userId: string) {
    const latest = await db.query.capabilityProfiles.findFirst({
      where: and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "applied")),
      orderBy: desc(schema.capabilityProfiles.profileVersion),
    });
    if (!latest) return null;

    const [capabilities, resources] = await Promise.all([
      db.query.userCapabilities.findMany({
        where: eq(schema.userCapabilities.capabilityProfileId, latest.id),
      }),
      db.query.userResources.findMany({
        where: eq(schema.userResources.capabilityProfileId, latest.id),
      }),
    ]);

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
    };
  }

  app.get("/profile", { preHandler: app.authenticate }, async (request, reply) => {
    const result = await loadAppliedProfile(request.userId);
    return reply.send(result ?? { profile: null, capabilities: [], resources: [] });
  });

  app.patch("/profile", { preHandler: app.authenticate }, async (request, reply) => {
    const body = updateProfileSchema.parse(request.body);

    const updates: Partial<typeof schema.userProfiles.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.cityId !== undefined) updates.cityId = body.cityId;
    if (body.whatsappPhone !== undefined) updates.whatsappPhone = body.whatsappPhone;

    const [updated] = await db
      .update(schema.userProfiles)
      .set(updates)
      .where(eq(schema.userProfiles.userId, request.userId))
      .returning();

    if (!updated) {
      return reply.code(404).send({ error: { code: "not_found", message: "Профиль не найден" } });
    }
    return reply.send({ name: updated.name, cityId: updated.cityId, whatsappPhone: updated.whatsappPhone });
  });

  app.post("/profile/inputs", { preHandler: app.authenticate }, async (request, reply) => {
    await withIdempotency(request, reply, "POST /profile/inputs", async (): Promise<{
      status: number;
      body: Record<string, unknown>;
    }> => {
      const body = profileInputSchema.parse(request.body);

      const config = getRuntimeConfig();
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentInputs = await db.query.profileSourceInputs.findMany({
        where: and(
          eq(schema.profileSourceInputs.userId, request.userId),
          gt(schema.profileSourceInputs.createdAt, hourAgo),
        ),
      });
      if (recentInputs.length >= config.rateLimits.profileFreeformEditsPerHour) {
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

      if (body.inputType === "voice" && body.audioMediaId) {
        const owned = await db.query.media.findFirst({
          where: and(eq(schema.media.id, body.audioMediaId), eq(schema.media.ownerId, request.userId)),
        });
        if (!owned) {
          return {
            status: 400 as const,
            body: {
              error: {
                code: "media_not_found",
                message: "audioMediaId не найден или принадлежит другому пользователю",
              },
            },
          };
        }
      }

      // Пауза «Проверка транскрипции» (экран 9): voice-ввод сначала уходит
      // только на STT (PROFILE_TRANSCRIBE) и ждёт подтверждения — text-ввод
      // нечего разделять, правка уже произошла в композере, сразу extraction.
      const [input] = await db
        .insert(schema.profileSourceInputs)
        .values({
          userId: request.userId,
          inputType: body.inputType,
          rawText: body.inputType === "text" ? (body.text ?? null) : null,
          audioMediaId: body.inputType === "voice" ? (body.audioMediaId ?? null) : null,
          status: body.inputType === "voice" ? "transcribing" : "confirmed",
        })
        .returning();
      if (!input) throw new Error("Failed to create profile_source_inputs row");

      const boss = await getBoss();
      if (body.inputType === "voice") {
        await boss.send(JOB_TYPES.PROFILE_TRANSCRIBE, { sourceInputId: input.id });
        return { status: 202 as const, body: { sourceInputId: input.id, status: "transcribing" as const } };
      }

      await boss.send(JOB_TYPES.PROFILE_EXTRACTION, { userId: request.userId, sourceInputId: input.id });
      return { status: 202 as const, body: { sourceInputId: input.id, status: "processing" as const } };
    });
  });

  app.get("/profile/inputs/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = await db.query.profileSourceInputs.findFirst({ where: eq(schema.profileSourceInputs.id, id) });
    if (!input || input.userId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Ввод не найден" } });
    }
    return reply.send({
      id: input.id,
      inputType: input.inputType,
      status: input.status,
      transcript: input.transcript,
      transcriptCorrected: input.transcriptCorrected,
      createdAt: input.createdAt,
    });
  });

  app.patch("/profile/inputs/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = editTranscriptSchema.parse(request.body);

    const input = await db.query.profileSourceInputs.findFirst({ where: eq(schema.profileSourceInputs.id, id) });
    if (!input || input.userId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Ввод не найден" } });
    }
    if (input.status !== "awaiting_review") {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Транскрипт нельзя редактировать в статусе "${input.status}"` },
      });
    }

    const [updated] = await db
      .update(schema.profileSourceInputs)
      .set({ transcriptCorrected: body.transcriptCorrected })
      .where(eq(schema.profileSourceInputs.id, id))
      .returning();
    return reply.send({ id: updated!.id, transcript: updated!.transcript, transcriptCorrected: updated!.transcriptCorrected });
  });

  app.post("/profile/inputs/:id/confirm", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await withIdempotency(request, reply, "POST /profile/inputs/:id/confirm", async (): Promise<{
      status: number;
      body: Record<string, unknown>;
    }> => {
      const input = await db.query.profileSourceInputs.findFirst({ where: eq(schema.profileSourceInputs.id, id) });
      if (!input || input.userId !== request.userId) {
        return { status: 404 as const, body: { error: { code: "not_found", message: "Ввод не найден" } } };
      }
      if (input.status !== "awaiting_review") {
        return {
          status: 409 as const,
          body: {
            error: { code: "invalid_status", message: `Нельзя подтвердить транскрипт в статусе "${input.status}"` },
          },
        };
      }

      await db
        .update(schema.profileSourceInputs)
        .set({ status: "confirmed" })
        .where(eq(schema.profileSourceInputs.id, id));

      const boss = await getBoss();
      await boss.send(JOB_TYPES.PROFILE_EXTRACTION, { userId: request.userId, sourceInputId: input.id });

      return { status: 202 as const, body: { sourceInputId: input.id, status: "processing" as const } };
    });
  });

  app.get("/profile/draft", { preHandler: app.authenticate }, async (request, reply) => {
    const draft = await db.query.capabilityProfiles.findFirst({
      where: and(eq(schema.capabilityProfiles.userId, request.userId), eq(schema.capabilityProfiles.status, "draft")),
      orderBy: desc(schema.capabilityProfiles.profileVersion),
    });
    if (!draft) return reply.send({ draft: null });

    const [draftCapabilities, draftResources, appliedResult] = await Promise.all([
      db.query.userCapabilities.findMany({ where: eq(schema.userCapabilities.capabilityProfileId, draft.id) }),
      db.query.userResources.findMany({ where: eq(schema.userResources.capabilityProfileId, draft.id) }),
      loadAppliedProfile(request.userId),
    ]);

    // Экран 10 ТЗ: «подтверждения удаления значимых пунктов» — дифф считаем
    // здесь, ДО применения, а не постфактум на клиенте (был временный
    // компромисс в slice 7 этой ветки, теперь заменяется этим эндпоинтом).
    const appliedCapabilityLabels = new Set((appliedResult?.capabilities ?? []).map((c) => c.label));
    const appliedResourceLabels = new Set((appliedResult?.resources ?? []).map((r) => r.label));
    const draftCapabilityLabels = new Set(draftCapabilities.map((c) => c.label));
    const draftResourceLabels = new Set(draftResources.map((r) => r.label));

    return reply.send({
      draft: {
        id: draft.id,
        summary: draft.summary,
        profileVersion: draft.profileVersion,
        createdAt: draft.createdAt,
      },
      capabilities: draftCapabilities,
      resources: draftResources,
      diff: {
        addedCapabilities: draftCapabilities.filter((c) => !appliedCapabilityLabels.has(c.label)).map((c) => c.label),
        removedCapabilities: (appliedResult?.capabilities ?? [])
          .filter((c) => !draftCapabilityLabels.has(c.label))
          .map((c) => c.label),
        addedResources: draftResources.filter((r) => !appliedResourceLabels.has(r.label)).map((r) => r.label),
        removedResources: (appliedResult?.resources ?? [])
          .filter((r) => !draftResourceLabels.has(r.label))
          .map((r) => r.label),
      },
    });
  });

  app.post("/profile/draft/:id/apply", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const draft = await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, id) });
    if (!draft || draft.userId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Черновик не найден" } });
    }
    if (draft.status !== "draft") {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Нельзя применить черновик в статусе "${draft.status}"` },
      });
    }

    await db
      .update(schema.capabilityProfiles)
      .set({ status: "superseded" })
      .where(and(eq(schema.capabilityProfiles.userId, request.userId), eq(schema.capabilityProfiles.status, "applied")));
    await db.update(schema.capabilityProfiles).set({ status: "applied" }).where(eq(schema.capabilityProfiles.id, id));

    return reply.send({ profileId: draft.id, status: "applied" as const });
  });

  app.post("/profile/draft/:id/discard", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const draft = await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, id) });
    if (!draft || draft.userId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Черновик не найден" } });
    }
    if (draft.status !== "draft") {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Нельзя отклонить черновик в статусе "${draft.status}"` },
      });
    }
    await db.update(schema.capabilityProfiles).set({ status: "discarded" }).where(eq(schema.capabilityProfiles.id, id));
    return reply.code(204).send();
  });

  app.get("/profile/preferences", { preHandler: app.authenticate }, async (request, reply) => {
    const preferences = await db.query.learnedPreferences.findMany({
      where: and(eq(schema.learnedPreferences.userId, request.userId), isNull(schema.learnedPreferences.revokedAt)),
    });

    // Раздел 27 ТЗ: «управление learned_preferences — отмена "не показывать
    // подобное"» — экран должен показать ЧТО пользователь скрыл, а не
    // голый ontologyNodeId. nameRu подтягивается тем же паттерном, что и
    // остальные join'ы по спискам в этом API.
    const nodeIds = [...new Set(preferences.map((p) => p.ontologyNodeId))];
    const nodes = nodeIds.length > 0
      ? await db.query.ontologyNodes.findMany({ where: (t, { inArray }) => inArray(t.id, nodeIds) })
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
  });

  app.delete("/profile/preferences/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await db.query.learnedPreferences.findFirst({
      where: eq(schema.learnedPreferences.id, id),
    });
    if (!existing || existing.userId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Предпочтение не найдено" } });
    }
    await db
      .update(schema.learnedPreferences)
      .set({ revokedAt: new Date() })
      .where(eq(schema.learnedPreferences.id, id));
    return reply.code(204).send();
  });
}
