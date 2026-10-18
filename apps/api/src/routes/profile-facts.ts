import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getDb, resolveProfileFactSlots, schema } from "@ustal/database";
import {
  correctProfileFactSchema,
  mentionsSensitiveCategory,
  PROFILE_FACT_TYPES,
  profileFactSlotKey,
  profileFactValueSchema,
  profileFactVisibilitySchema,
  profileFactIdParamSchema as idParam,
  profileFactSourceParamSchema as sourceParam,
  profileFactsListQuerySchema as listQuery,
  type ProfileFactType,
  type ProfileFactValue,
} from "@ustal/validation";
import { revokeProfileSourceInput } from "../lib/source-revoke.js";

/**
 * Phase 2A profile_facts — OWNER-ONLY control API (no UI yet). Every query is scoped by the authenticated
 * user; another user's fact is indistinguishable from a missing one (404). There is no search/listing of
 * other people's facts and existing public endpoints (/users/:id, /orders/:id/author, feed, responses)
 * never read these tables. Facts are still SHADOW: nothing here feeds matching.
 *
 * Precedence: user corrected > user confirmed > AI (explicit/inferred); see @ustal/database
 * resolveProfileFactSlots. Revocation is a soft, terminal user decision (audit kept, never re-activated by
 * reprocessing). visibility: private (default) | shareable (disclosure still needs a future explicit action).
 */
type Fact = typeof schema.profileFacts.$inferSelect;
const MUTABLE = ["active", "superseded"];

const trust = (f: Fact) =>
  f.userDecision === "corrected" ? "user_corrected"
    : f.userDecision === "confirmed" ? "user_confirmed"
      : f.userDecision === "revoked" ? "user_revoked"
        : f.assertion === "explicit" ? "ai_explicit" : "ai_inferred";

export function factDto(f: Fact) {
  return {
    id: f.id,
    factType: f.factType,
    value: (f.userValue ?? f.value) as ProfileFactValue,
    aiValue: f.userDecision === "corrected" ? (f.value as ProfileFactValue) : undefined,
    evidence: f.evidence,
    sourceInputId: f.sourceInputId,
    assertion: f.assertion,
    confidence: Number(f.confidence),
    trust: trust(f),
    status: f.status,
    userDecision: f.userDecision,
    visibility: f.visibility,
    supersededByFactId: f.supersededByFactId,
    decidedAt: f.decidedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: { code: "not_found", message: "Факт не найден" } });
const conflict = (reply: FastifyReply, message: string) => reply.code(409).send({ error: { code: "invalid_status", message } });

export default async function profileFactsRoutes(app: FastifyInstance) {
  const db = getDb();

  /** Runs a mutation of one owned fact under the per-user facts lock (same key as the worker). */
  async function withOwnedFact<T>(userId: string, id: string, fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], fact: Fact) => Promise<T>) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 2))`);
      const [fact] = await tx.select().from(schema.profileFacts)
        .where(and(eq(schema.profileFacts.id, id), eq(schema.profileFacts.userId, userId))).for("update");
      return fn(tx, fact as Fact);
    });
  }
  const reload = async (id: string) => (await db.select().from(schema.profileFacts).where(eq(schema.profileFacts.id, id)))[0]!;

  app.get("/profile/facts", { preHandler: app.authenticate }, async (request, reply) => {
    const { include } = listQuery.parse(request.query ?? {});
    const hidden = include === "all" ? ["replaced"] : ["replaced", "revoked"];
    const rows = await db.select().from(schema.profileFacts)
      .where(and(eq(schema.profileFacts.userId, request.userId), notInArray(schema.profileFacts.status, hidden)))
      .orderBy(asc(schema.profileFacts.factType), asc(schema.profileFacts.createdAt))
      .limit(500);
    return reply.send({ facts: rows.map(factDto) });
  });

  app.post("/profile/facts/:id/confirm", { preHandler: app.authenticate }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const result = await withOwnedFact(request.userId, p.data.id, async (tx, fact) => {
      if (!fact) return "missing" as const;
      if (!MUTABLE.includes(fact.status)) return "status" as const;
      // A correction already outranks a confirmation: confirming it again keeps "corrected".
      if (fact.userDecision !== "corrected")
        await tx.update(schema.profileFacts).set({ userDecision: "confirmed", decidedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.profileFacts.id, fact.id));
      await resolveProfileFactSlots(tx, request.userId, [fact.slotKey]);
      return "ok" as const;
    });
    if (result === "missing") return notFound(reply);
    if (result === "status") return conflict(reply, "Этот факт нельзя подтвердить");
    return reply.send({ fact: factDto(await reload(p.data.id)) });
  });

  app.patch("/profile/facts/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const body = correctProfileFactSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: "validation_error", message: "Некорректное значение", details: body.error.issues } });
    const result = await withOwnedFact(request.userId, p.data.id, async (tx, fact) => {
      if (!fact) return { kind: "missing" as const };
      if (!MUTABLE.includes(fact.status)) return { kind: "status" as const };
      const type = fact.factType as ProfileFactType;
      const merged = profileFactValueSchema.safeParse({ ...((fact.userValue ?? fact.value) as ProfileFactValue), ...body.data.value });
      if (!merged.success) return { kind: "invalid" as const };
      const needs = PROFILE_FACT_TYPES[type]?.requires;
      if ((needs === "label" && !merged.data.label) || (needs === "number" && merged.data.number === null) || (needs === "flag" && merged.data.flag === null))
        return { kind: "invalid" as const };
      // The same privacy rule as for AI output: special-category data is not stored in facts.
      if (mentionsSensitiveCategory(`${merged.data.label ?? ""} ${merged.data.level ?? ""} ${merged.data.unit ?? ""}`)) return { kind: "sensitive" as const };
      const slotKey = profileFactSlotKey(type, merged.data);
      await tx.update(schema.profileFacts).set({ userDecision: "corrected", userValue: merged.data, slotKey, decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.profileFacts.id, fact.id));
      await resolveProfileFactSlots(tx, request.userId, [fact.slotKey, slotKey]);
      return { kind: "ok" as const };
    });
    if (result.kind === "missing") return notFound(reply);
    if (result.kind === "status") return conflict(reply, "Этот факт нельзя исправить");
    if (result.kind === "invalid") return reply.code(400).send({ error: { code: "validation_error", message: "Некорректное значение для этого типа факта" } });
    if (result.kind === "sensitive") return reply.code(422).send({ error: { code: "sensitive_data", message: "Чувствительные личные данные в профиль не сохраняются" } });
    return reply.send({ fact: factDto(await reload(p.data.id)) });
  });

  app.patch("/profile/facts/:id/visibility", { preHandler: app.authenticate }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const body = profileFactVisibilitySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: { code: "validation_error", message: "visibility: private | shareable" } });
    const result = await withOwnedFact(request.userId, p.data.id, async (tx, fact) => {
      if (!fact) return "missing" as const;
      if (!MUTABLE.includes(fact.status)) return "status" as const;
      await tx.update(schema.profileFacts).set({ visibility: body.data.visibility, updatedAt: new Date() }).where(eq(schema.profileFacts.id, fact.id));
      return "ok" as const;
    });
    if (result === "missing") return notFound(reply);
    if (result === "status") return conflict(reply, "Для этого факта нельзя изменить видимость");
    return reply.send({ fact: factDto(await reload(p.data.id)) });
  });

  app.delete("/profile/facts/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const result = await withOwnedFact(request.userId, p.data.id, async (tx, fact) => {
      if (!fact) return "missing" as const;
      if (fact.status === "revoked") return "ok" as const;
      if (!MUTABLE.includes(fact.status)) return "status" as const;
      await tx.update(schema.profileFacts).set({ status: "revoked", userDecision: "revoked", userValue: null, supersededByFactId: null, decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.profileFacts.id, fact.id));
      await resolveProfileFactSlots(tx, request.userId, [fact.slotKey]);
      return "ok" as const;
    });
    if (result === "missing") return notFound(reply);
    if (result === "status") return conflict(reply, "Этот факт нельзя отозвать");
    return reply.code(204).send();
  });

  /**
   * Withdraw one of MY messages. Alias of DELETE /profile/inputs/:id — one revoke semantics for the facts
   * layer AND the AI profile (see lib/source-revoke.ts).
   */
  app.delete("/profile/facts/sources/:sourceInputId", { preHandler: app.authenticate }, async (request, reply) => {
    const p = sourceParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const result = await revokeProfileSourceInput(request.userId, p.data.sourceInputId);
    if (!result) return reply.code(404).send({ error: { code: "not_found", message: "Ввод не найден" } });
    return reply.code(204).send();
  });
}
