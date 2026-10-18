import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import profileRoutes from "./profile.js";

assertLocalTestDatabase();
const db = getDb();
const users: string[] = [];
afterAll(async () => {
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  await getSql().end();
});

async function fixture(latestStatus: "draft" | "applied") {
  const [user] = await db.insert(schema.users).values({
    phone: randomUUID().slice(0, 20), passwordHash: "local-test",
  }).returning();
  users.push(user!.id);
  const profiles = await db.insert(schema.capabilityProfiles).values([
    { userId: user!.id, summary: "old draft", profileVersion: 1, extractionVersion: "test", status: "draft" },
    { userId: user!.id, summary: "new skills", profileVersion: 2, extractionVersion: "test", status: latestStatus },
  ]).returning();
  const [old, latest] = profiles;
  await db.insert(schema.userCapabilities).values({
    capabilityProfileId: latest!.id, ontologyNodeId: randomUUID(), label: "ремонт автомобиля",
    evidenceType: "explicit", confidence: "0.95",
  });
  await db.insert(schema.userResources).values({
    capabilityProfileId: latest!.id, ontologyNodeId: randomUUID(), label: "автомобиль",
    resourceType: "transport", evidenceType: "explicit", confidence: "0.95",
  });
  const app = Fastify();
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => { request.userId = user!.id; });
  await app.register(profileRoutes);
  await app.ready();
  return { app, old: old!, latest: latest! };
}

it("applying a newer draft retires older drafts and preserves its saved items", async () => {
  const { app, old, latest } = await fixture("draft");
  try {
    const result = await app.inject({ method: "POST", url: `/profile/draft/${latest.id}/apply`, payload: {} });
    expect(result.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/profile/draft" })).json()).toMatchObject({ draft: null });
    expect((await db.query.capabilityProfiles.findFirst({ where: eq(schema.capabilityProfiles.id, old.id) }))?.status).toBe("superseded");
    expect((await app.inject({ method: "POST", url: `/profile/draft/${old.id}/apply`, payload: {} })).statusCode).toBe(409);
    const saved = (await app.inject({ method: "GET", url: "/profile" })).json();
    expect(saved.profile.id).toBe(latest.id);
    expect(saved.capabilities.map((c: { label: string }) => c.label)).toEqual(["ремонт автомобиля"]);
    expect(saved.resources.map((r: { label: string }) => r.label)).toEqual(["автомобиль"]);
  } finally { await app.close(); }
});

it("hides and rejects a legacy draft older than the applied profile", async () => {
  const { app, old, latest } = await fixture("applied");
  try {
    expect((await app.inject({ method: "GET", url: "/profile/draft" })).json()).toMatchObject({ draft: null });
    const result = await app.inject({ method: "POST", url: `/profile/draft/${old.id}/apply`, payload: {} });
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe("stale_draft");
    expect((await app.inject({ method: "GET", url: "/profile" })).json().profile.id).toBe(latest.id);
  } finally { await app.close(); }
});

it("concurrent applies cannot leave the older version applied", async () => {
  const { app, old, latest } = await fixture("draft");
  try {
    const results = await Promise.all([latest, old].map((p) => app.inject({ method: "POST", url: `/profile/draft/${p.id}/apply`, payload: {} })));
    expect(results[0]!.statusCode).toBe(200);
    expect([200, 409]).toContain(results[1]!.statusCode);
    expect((await app.inject({ method: "GET", url: "/profile" })).json().profile.id).toBe(latest.id);
  } finally { await app.close(); }
});
