import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import Fastify from "fastify";
import { inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import profileRoutes from "./profile.js";

assertLocalTestDatabase();
const db = getDb();
const users: string[] = [];
afterAll(async () => {
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await getSql().end();
});

async function app(userId: string) {
  const a = Fastify();
  a.decorate("authenticate", async (request: import("fastify").FastifyRequest) => { request.userId = userId; });
  await a.register(profileRoutes);
  await a.ready();
  return a;
}

it("GET /profile returns the saved explicit restrictions read-only and leaves skills/resources unchanged", async () => {
  const [user] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  users.push(user!.id);
  const [profile] = await db.insert(schema.capabilityProfiles).values({ userId: user!.id, summary: "s", profileVersion: 1, extractionVersion: "test", status: "applied" }).returning();
  const text = "Умею ремонтировать технику. Есть кофемашина. Не занимаюсь доставкой после 22:00. Не выполняю перевозки.";
  const [doc] = await db.insert(schema.matchingDocuments).values({ profileId: profile!.id, sourceText: text, processingVersion: "test", sourceHash: randomUUID(), embeddingModel: "test" }).returning();
  const base = { documentId: doc!.id, nodeIds: [], confidence: "0.95", mandatory: false };
  await db.insert(schema.matchingFacts).values([
    { ...base, kind: "capability", phrase: "ремонт техники", evidence: "Умею ремонтировать технику." },
    { ...base, kind: "resource", phrase: "есть кофемашина", evidence: "Есть кофемашина.", resourceRole: "available" },
    { ...base, kind: "availability", phrase: "доставка", evidence: "Не занимаюсь доставкой после 22:00.", constraintType: "availability", constraintScope: "fact", endHour: 22 },
    { ...base, kind: "exclude", phrase: "перевозки", evidence: "Не выполняю перевозки.", constraintType: "exclusion" },
    // Снятое пользователем ограничение — история, не показывается.
    { ...base, kind: "superseded", phrase: "не работаю после 22:00", evidence: "Не работаю после 22:00." },
  ]);
  const a = await app(user!.id);
  try {
    const body = (await a.inject({ method: "GET", url: "/profile" })).json();
    // 2026-10-17: у ограничений и неизвестных пунктов есть id факта (для прямых действий «Снять»/«Убрать»).
    const withoutId = (items: { id?: unknown }[]) => items.map(({ id, ...rest }) => { expect(typeof id).toBe("string"); return rest; });
    body.restrictions = withoutId(body.restrictions);
    body.unmapped = withoutId(body.unmapped);
    expect(body.restrictions).toEqual([
      { type: "time", text: "Доставка — до 22:00" },
      { type: "work", text: "Не выполняю: перевозки" },
    ]);
    expect(body.unmapped).toEqual([
      { kind: "capability", phrase: "ремонт техники" },
      { kind: "resource", phrase: "есть кофемашина" },
    ]);
  } finally { await a.close(); }
});

it("GET /profile without a profile returns an empty restrictions list", async () => {
  const [user] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  users.push(user!.id);
  const a = await app(user!.id);
  try {
    expect((await a.inject({ method: "GET", url: "/profile" })).json()).toMatchObject({ profile: null, restrictions: [] });
  } finally { await a.close(); }
});
