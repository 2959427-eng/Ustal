/**
 * Регрессия (реальный случай 2026-10-14): «Могу копать» → навык есть → удаление ресурсов → навык незаметно
 * пропал. Настоящий путь: handler (incremental) → persistence → POST /profile/draft/:id/apply → GET /profile
 * + факты применённого документа. AI — fixture: честный и злонамеренный (лишние removes, echo).
 * После КАЖДОГО шага: «копать» активен (в user_capabilities, GET /profile и matching facts) — до явного
 * «Больше не могу копать»; после него навык не возвращается от операций с ресурсами.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { mockProviders } from "@ustal/ai";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
vi.mock("@ustal/queue", async (orig) => ({ ...(await orig<typeof import("@ustal/queue")>()), getBoss: vi.fn(async () => ({ send: vi.fn(async () => "job") })) }));
const { handleProfileExtraction } = await import("../src/handlers/profile-extraction.js");
const { priorFactsFromRows } = await import("../src/semantic.js");
const { isRevokedCapability } = await import("../src/profile-negatives.js");
const profileRoutes = (await import("../../api/src/routes/profile.js")).default;

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const users: string[] = [], cities: string[] = [];
type T = { kind: string; key?: string };
let current: { facts: unknown[]; removes: T[] } = { facts: [], removes: [] };
const wrap = (data: unknown) => ({ data, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 }) as never;
const PHRASE: Record<string, string> = { digging: "копать", drill: "дрель", ladder: "стремянка", car: "машина", van: "газель" };
const KEY_OF_PHRASE = new Map(Object.entries(PHRASE).map(([k, p]) => [p, k]));
const f = (kind: string, key: string, over: Record<string, unknown> = {}) => ({ kind, phrase: PHRASE[key], canonicalKeys: [key], evidence: "", subjectType: kind === "resource" ? "physical_resource" : "unspecified",
  confidence: 0.95, mandatory: false, constraintType: "none", constraintScope: "whole_task", resourceRole: kind === "resource" ? "available" : "none",
  resourceCapacity: { value: null, unit: null, kind: null }, startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null, ...over });
const skill = (k: string) => f("capability", k), res = (k: string) => f("resource", k), gone = (k: string) => f("resource", k, { resourceRole: "missing" });
const revoke = (k: string) => f("exclude", k, { constraintType: "exclusion", refusalIntent: "revoke" });
let keyOfNode = new Map<string, string>();

beforeAll(async () => {
  app.decorate("authenticate", async (r: import("fastify").FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
  await app.register(profileRoutes); await app.ready();
  keyOfNode = new Map((await db.select({ id: schema.ontologyNodes.id, key: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes)
    .where(inArray(schema.ontologyNodes.canonicalKey, Object.keys(PHRASE)))).map((r) => [r.id, r.key]));
  vi.spyOn(mockProviders.extraction, "extractCapabilityProfile").mockImplementation(async (i) => wrap({ summary: i.text, capabilities: [], resources: [] }));
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
    const items = (input as { profileItems?: { id: string; type: string; phrase: string }[] }).profileItems;
    const removes = items ? current.removes.flatMap((t) => items.filter((i) => t.kind === "all" ||
      (i.type === t.kind && (!t.key || KEY_OF_PHRASE.get(i.phrase) === t.key))).map((i) => i.id)) : undefined;
    return wrap({ facts: current.facts.map((x) => ({ ...(x as object), evidence: input.text })), ...(removes ? { removes } : {}) });
  });
});
afterAll(async () => {
  await app.close();
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});

interface Step { msg: string; honest: { facts: unknown[]; removes: T[] }; hostile: { facts: unknown[]; removes: T[] }; skills: string[]; resources: string[]; revoked: string[] }
const S = (msg: string, facts: unknown[], removes: T[], hostileExtra: { facts?: unknown[]; removes?: T[] }, skills: string[], resources: string[], revoked: string[] = []): Step =>
  ({ msg, honest: { facts, removes }, hostile: { facts: [...facts, ...(hostileExtra.facts ?? [])], removes: [...removes, ...(hostileExtra.removes ?? [])] }, skills, resources, revoked });
const D = ["digging"];
const STEPS: Step[] = [
  S("Могу копать", [skill("digging")], [], {}, D, []),
  S("Есть дрель", [res("drill")], [], {}, D, ["drill"]),
  S("Есть стремянка", [res("ladder")], [], { removes: [{ kind: "skill", key: "digging" }] }, D, ["drill", "ladder"]),
  S("Есть машина", [res("car")], [], {}, D, ["car", "drill", "ladder"]),
  S("Дрель продал", [gone("drill")], [{ kind: "resource", key: "drill" }], { removes: [{ kind: "skill", key: "digging" }] }, D, ["car", "ladder"]),
  S("Стремянки больше нет", [gone("ladder")], [{ kind: "resource", key: "ladder" }], { removes: [{ kind: "all" }] }, D, ["car"]),
  S("Снова есть дрель", [res("drill")], [{ kind: "no_resource", key: "drill" }], { removes: [{ kind: "skill", key: "digging" }] }, D, ["car", "drill"]),
  S("Спасибо!", [], [], { facts: [gone("car")], removes: [{ kind: "all" }] }, D, ["car", "drill"]),
  S("Машину поменял на газель", [gone("car"), res("van")], [{ kind: "resource", key: "car" }], { removes: [{ kind: "skill", key: "digging" }] }, D, ["drill", "van"]),
  S("Больше не могу копать", [revoke("digging")], [{ kind: "skill", key: "digging" }], {}, [], ["drill", "van"], D),
  S("Стремянка снова есть", [res("ladder")], [{ kind: "no_resource", key: "ladder" }], { facts: [skill("digging")], removes: [{ kind: "removed_skill", key: "digging" }] }, [], ["drill", "ladder", "van"], D),
  S("Газель продал", [gone("van")], [{ kind: "resource", key: "van" }], { facts: [skill("digging")] }, [], ["drill", "ladder"], D),
];

for (const mode of ["honest", "hostile"] as const)
  it(`«копать» survives resource changes and is removed only by an explicit revoke (${mode} AI)`, async () => {
    const [city] = await db.insert(schema.cities).values({ name: "QA_DIG_" + randomUUID(), regionName: "QA", federalDistrict: "QA", timezone: "Asia/Vladivostok", isActive: false }).returning();
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "qa", status: "active" }).returning();
    users.push(u!.id); cities.push(city!.id);
    await db.insert(schema.userProfiles).values({ userId: u!.id, cityId: city!.id, name: "QA", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
    const failures: string[] = [];
    for (const [n, step] of STEPS.entries()) {
      current = step[mode];
      const [src] = await db.insert(schema.profileSourceInputs).values({ userId: u!.id, inputType: "text", rawText: step.msg, status: "confirmed" }).returning();
      const { profileId } = await handleProfileExtraction({ id: randomUUID(), data: { userId: u!.id, sourceInputId: src!.id } } as never);
      const applied = await app.inject({ method: "POST", url: `/profile/draft/${profileId}/apply`, headers: { "x-test-user": u!.id, "idempotency-key": randomUUID() } });
      const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profileId), orderBy: desc(schema.matchingDocuments.processedAt) });
      const facts = priorFactsFromRows(await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc!.id))).filter((x) => (x.kind as string) !== "superseded");
      const key = (x: { nodeIds: string[]; phrase: string }) => x.nodeIds.map((id) => keyOfNode.get(id)).find(Boolean) ?? `?${x.phrase}`;
      const ref = (x: (typeof facts)[number]) => x.kind === "exclude" || x.constraintType === "exclusion";
      const shown = (await app.inject({ method: "GET", url: "/profile", headers: { "x-test-user": u!.id } })).json() as { capabilities: { label: string }[]; resources: { label: string }[] };
      const actual = {
        apply: applied.statusCode,
        skills: [...new Set(facts.filter((x) => x.kind === "capability" && !ref(x)).map(key))].sort(),
        resources: [...new Set(facts.filter((x) => x.kind === "resource" && x.resourceRole !== "missing").map(key))].sort(),
        revoked: facts.filter((x) => ref(x) && isRevokedCapability(x)).map(key).sort(),
        apiSkills: shown.capabilities.map((c) => c.label).sort(),
      };
      const expected = { apply: 200, skills: step.skills, resources: step.resources, revoked: step.revoked, apiSkills: step.skills.includes("digging") ? ["копать"] : [] };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${n + 1} «${step.msg}»: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  }, 60_000);
