import type { FastifyInstance } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getRuntimeConfig } from "@ustal/config";
import { getBoss, JOB_TYPES } from "@ustal/queue";
import { profileInputSchema, updateProfileSchema } from "@ustal/validation";
import { withIdempotency } from "../lib/idempotency.js";

/**
 * Профиль возможностей (docs/api.md, docs/matching.md пайплайн профиля).
 * `capability_profiles` — append-only: каждая AI-правка создаёт новую версию,
 * а не перезаписывает старую (docs/data-model.md). `PATCH /profile` — точечные
 * правки без AI (город, имя, WhatsApp), не версионируется отдельно и не
 * требует Idempotency-Key.
 */
export default async function profileRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/profile", { preHandler: app.authenticate }, async (request, reply) => {
    const latest = await db.query.capabilityProfiles.findFirst({
      where: eq(schema.capabilityProfiles.userId, request.userId),
      orderBy: (t, { desc }) => desc(t.profileVersion),
    });

    if (!latest) {
      return reply.send({ profile: null, capabilities: [], resources: [] });
    }

    const [capabilities, resources] = await Promise.all([
      db.query.userCapabilities.findMany({
        where: eq(schema.userCapabilities.capabilityProfileId, latest.id),
      }),
      db.query.userResources.findMany({
        where: eq(schema.userResources.capabilityProfileId, latest.id),
      }),
    ]);

    return reply.send({
      profile: {
        id: latest.id,
        summary: latest.summary,
        profileVersion: latest.profileVersion,
        extractionVersion: latest.extractionVersion,
        createdAt: latest.createdAt,
      },
      capabilities,
      resources,
    });
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

      const [input] = await db
        .insert(schema.profileSourceInputs)
        .values({
          userId: request.userId,
          inputType: body.inputType,
          rawText: body.inputType === "text" ? (body.text ?? null) : null,
          audioMediaId: body.inputType === "voice" ? (body.audioMediaId ?? null) : null,
        })
        .returning();
      if (!input) throw new Error("Failed to create profile_source_inputs row");

      const boss = await getBoss();
      await boss.send(JOB_TYPES.PROFILE_EXTRACTION, { userId: request.userId, sourceInputId: input.id });

      return { status: 202 as const, body: { sourceInputId: input.id, status: "processing" as const } };
    });
  });

  app.get("/profile/preferences", { preHandler: app.authenticate }, async (request, reply) => {
    const preferences = await db.query.learnedPreferences.findMany({
      where: and(eq(schema.learnedPreferences.userId, request.userId), isNull(schema.learnedPreferences.revokedAt)),
    });
    return reply.send(preferences);
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
