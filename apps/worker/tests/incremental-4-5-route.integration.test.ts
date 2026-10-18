/**
 * №4/№5 integration route (QA 2026-10-14): длинная история спецификации (18 сообщений) через НАСТОЯЩИЙ путь —
 * profile_source_inputs → handleProfileExtraction (incremental, prior из сохранённого документа) →
 * persistence → POST /profile/draft/:id/apply → наблюдение применённой версии: факты документа из БД,
 * GET /profile (навыки, ресурсы, ограничения — то, что видит пользователь) и настоящий matching.
 * AI — fixture спецификации; remove-targets разрешаются по CURRENT_PROFILE, который получил normalization.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { mockProviders } from "@ustal/ai";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { evaluateSemantic } from "@ustal/matching";
import { scenarios, fact, type RemoveTarget } from "../../../docs/evaluations/qa-2026-10-14/incremental-4-5-spec/fixtures.js";
import { stateViolations, type ObservedState } from "../../../docs/evaluations/qa-2026-10-14/incremental-4-5-spec/helpers.js";
vi.mock("@ustal/queue", async (orig) => ({ ...(await orig<typeof import("@ustal/queue")>()), getBoss: vi.fn(async () => ({ send: vi.fn(async () => "job") })) }));
const { handleProfileExtraction } = await import("../src/handlers/profile-extraction.js");
const { prepareDocument, priorFactsFromRows } = await import("../src/semantic.js");
const { isRevokedCapability } = await import("../src/profile-negatives.js");
const { pickRestrictions } = await import("../../api/src/lib/profile-diff.js");
const profileRoutes = (await import("../../api/src/routes/profile.js")).default;

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const users: string[] = [], cities: string[] = [];
const KEYS = ["appliance_repair", "digging", "assembly", "van", "refrigerator_repair", "delivery"];
let keyOfNode = new Map<string, string>();
const keyOfPhrase = new Map<string, string>([...KEYS, "plane"].map((k) => [fact(k).phrase.replace(/ё/g, "е"), k]));
let current: { facts: unknown[]; removes: RemoveTarget[] } = { facts: [], removes: [] };
const wrap = (data: unknown) => ({ data, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 }) as never;

beforeAll(async () => {
  app.decorate("authenticate", async (r: import("fastify").FastifyRequest) => { r.userId = r.headers["x-test-user"] as string; });
  await app.register(profileRoutes); await app.ready();
  const rows = await db.select({ id: schema.ontologyNodes.id, key: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes).where(inArray(schema.ontologyNodes.canonicalKey, KEYS));
  keyOfNode = new Map(rows.map((r) => [r.id, r.key]));
  vi.spyOn(mockProviders.extraction, "extractCapabilityProfile").mockImplementation(async (i) => wrap({ summary: i.text, capabilities: [], resources: [] }));
  vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
    const items = (input as { profileItems?: { id: string; type: string; phrase: string }[] }).profileItems;
    const removes = items ? current.removes.flatMap((t) => items.filter((i) => t.kind === "all" ||
      (i.type === t.kind && (!t.key || keyOfPhrase.get(i.phrase.replace(/ё/g, "е")) === t.key))).map((i) => i.id)) : undefined;
    return wrap({ facts: current.facts, ...(removes ? { removes } : {}) });
  });
});
afterAll(async () => {
  await app.close();
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});

const keyOf = (f: { nodeIds: string[]; phrase: string }) => {
  const k = f.nodeIds.map((id) => keyOfNode.get(id)).filter(Boolean);
  return k.length ? k.join("+") : keyOfPhrase.get(f.phrase.toLowerCase().replace(/ё/g, "е")) ?? `?${f.phrase}`;
};

it("D45-LONG-18 through the real handler → persistence → apply → GET /profile", async () => {
  const [city] = await db.insert(schema.cities).values({ name: "QA_INC_" + randomUUID(), regionName: "QA", federalDistrict: "QA", timezone: "Asia/Vladivostok", isActive: false }).returning();
  const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "qa", status: "active" }).returning();
  users.push(u!.id); cities.push(city!.id);
  await db.insert(schema.userProfiles).values({ userId: u!.id, cityId: city!.id, name: "QA", acceptedRulesAt: new Date(), acceptedPdnAt: new Date() });
  const long = scenarios.find((s) => s.id === "D45-LONG-18")!;
  const failures: string[] = [];
  for (const step of long.steps) {
    current = { facts: step.ai.facts, removes: step.ai.removes };
    const [src] = await db.insert(schema.profileSourceInputs).values({ userId: u!.id, inputType: "text", rawText: step.message, status: "confirmed" }).returning();
    const { profileId } = await handleProfileExtraction({ id: randomUUID(), data: { userId: u!.id, sourceInputId: src!.id } } as never);
    const applied = await app.inject({ method: "POST", url: `/profile/draft/${profileId}/apply`, headers: { "x-test-user": u!.id, "idempotency-key": randomUUID() } });
    expect(applied.statusCode, `${step.id} apply`).toBe(200);
    // Наблюдение: применённая версия (факты документа) + то, что видит пользователь.
    const doc = await db.query.matchingDocuments.findFirst({ where: eq(schema.matchingDocuments.profileId, profileId), orderBy: desc(schema.matchingDocuments.processedAt) });
    expect(doc!.sourceText.endsWith(step.message), `${step.id} sourceText keeps the message history`).toBe(true);
    const facts = priorFactsFromRows(await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc!.id)));
    const a = facts.filter((f) => (f.kind as string) !== "superseded");
    const isRef = (f: (typeof a)[number]) => f.kind === "exclude" || f.constraintType === "exclusion";
    const actual: ObservedState = {
      skills: a.filter((f) => f.kind === "capability" && !isRef(f) && f.constraintType !== "scope").map(keyOf),
      resources: a.filter((f) => f.kind === "resource" && f.resourceRole !== "missing").map(keyOf),
      missingResources: a.filter((f) => f.kind === "resource" && f.resourceRole === "missing").map(keyOf),
      revokedSkills: a.filter((f) => isRef(f) && isRevokedCapability(f)).map(keyOf),
      workRestrictions: a.filter((f) => isRef(f) && !isRevokedCapability(f)).map(keyOf),
      timeRestrictions: a.filter((f) => f.kind === "availability").map((f) => ({ scope: f.constraintScope === "fact" ? "activity" as const : "global" as const,
        endHour: f.endHour ?? null, label: pickRestrictions([f])[0]?.text ?? "" })),
    };
    if (actual.skills.includes("digging")) {
      const base = { subjectType: "unspecified", confidence: 0.95, constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null }, daysOfWeek: null, refusalIntent: null, startHour: null, endHour: null };
      const text = "Нужно выкопать яму в 23:00";
      current = { facts: [{ ...base, kind: "capability", phrase: "выкопать яму", evidence: text, canonicalKeys: ["digging"], mandatory: true, constraintType: "none" },
        { ...base, kind: "availability", phrase: "в 23:00", evidence: text, canonicalKeys: [], mandatory: true, constraintType: "availability", startHour: 23 }], removes: [] };
      const req = await prepareDocument("order", text, {}, randomUUID());
      const r = evaluateSemantic({ capabilities: facts, requirements: req.facts, relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false });
      actual.order23 = { rejected: r.classification === "reject", reason: String(r.reason ?? r.classification) };
    }
    const v = stateViolations(actual, step.expected);
    // Пользователь видит в «Ограничениях» ровно действующие окна (с часами) и узкие отказы.
    const shown = (await app.inject({ method: "GET", url: "/profile", headers: { "x-test-user": u!.id } })).json() as { restrictions: { type: string; text: string }[] };
    const shownTimes = shown.restrictions.filter((r) => r.type === "time").map((r) => r.text);
    if (JSON.stringify(shownTimes) !== JSON.stringify(step.expected.globalEndHours.map((h) => `Работаю до ${h}:00`)))
      v.push(`GET /profile time restrictions: expected ${JSON.stringify(step.expected.globalEndHours)}, shown ${JSON.stringify(shownTimes)}`);
    if (shown.restrictions.filter((r) => r.type === "work").length !== step.expected.workRestrictions.length)
      v.push(`GET /profile work restrictions: expected ${step.expected.workRestrictions.length}, shown ${JSON.stringify(shown.restrictions)}`);
    if (v.length) failures.push(`${step.id} «${step.message}»: ${v.join("; ")}`);
  }
  expect(failures, failures.join("\n")).toEqual([]);
}, 120_000);
