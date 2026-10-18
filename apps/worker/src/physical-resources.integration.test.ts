import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { recordOntologyCandidates } from "@ustal/ontology";
import { prepareDocument, unknownConceptPhrases } from "./semantic.js";
assertLocalTestDatabase();
afterAll(async () => { await getSql().end(); });

/**
 * 2026-10-05: AI must understand any resource/skill; the ontology only structures known ones.
 * The AI output is injected (no live model here): these tests pin the SERVER behaviour for what
 * the model returns, including the wrong "closest node" picks that turned «есть самолёт» into a skill.
 */
type Raw = { kind: "capability" | "resource"; subjectType?: "unspecified" | "physical_resource"; keys: string[]; role?: "available" | "none" };
const fact = (phrase: string, r: Raw) => ({
  kind: r.kind, subjectType: r.subjectType ?? "unspecified", phrase, evidence: phrase, canonicalKeys: r.keys, confidence: 0.95,
  mandatory: false, constraintType: "none" as const, constraintScope: "fact" as const,
  resourceRole: r.role ?? (r.kind === "resource" ? ("available" as const) : ("none" as const)),
  resourceCapacity: { value: null, unit: null, kind: null }, startHour: null, endHour: null, daysOfWeek: null,
});
async function prepare(phrase: string, r: Raw) {
  const spy = vi.spyOn(mockProviders.extraction, "normalizeMatching").mockResolvedValue({
    data: { facts: [fact(phrase, r)] }, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0,
  });
  try { return (await prepareDocument("profile", phrase, {}, randomUUID())).facts; } finally { spy.mockRestore(); }
}
async function keysOf(ids: string[]) {
  if (!ids.length) return [];
  const rows = await getDb().select({ k: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes).where(inArray(schema.ontologyNodes.id, ids));
  return rows.map((r) => r.k).sort();
}
const asset = (keys: string[]): Raw => ({ kind: "resource", subjectType: "physical_resource", keys });

describe("physical resources: classify first, then map; no node is not a reason to change kind", () => {
  it("«есть машина» -> resource + car node", async () => {
    const [f] = await prepare("есть машина", asset(["car"]));
    expect(f).toMatchObject({ kind: "resource", resourceRole: "available" });
    expect(await keysOf(f!.nodeIds)).toEqual(["car"]);
  });
  it("«есть дрель» -> resource + drill node", async () => {
    const [f] = await prepare("есть дрель", asset(["drill"]));
    expect(f!.kind).toBe("resource");
    expect(await keysOf(f!.nodeIds)).toEqual(["drill"]);
  });
  it.each([
    ["есть кофемашина", ["food_catering"]],
    ["есть стол", []],
    ["есть грабли", ["gardening"]],
    ["есть самолёт", ["driving"]],
    ["есть самолет", ["machinery_work"]],
  ])("%s -> resource without node, even when AI picked an action/capability node %j", async (phrase, keys) => {
    const facts = await prepare(phrase, asset(keys));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: "resource", phrase, nodeIds: [], resourceRole: "available" });
    expect(facts[0]!.embedding.some((x) => x !== 0)).toBe(true);
  });
  it("a physical asset keeps only its compatible resource node when AI mixed in a skill node", async () => {
    const [f] = await prepare("есть машина", asset(["car", "driving"]));
    expect(f!.kind).toBe("resource");
    expect(await keysOf(f!.nodeIds)).toEqual(["car"]);
  });
  it("«вайбкодер» (outside the seed) stays a capability without node, not lost", async () => {
    const facts = await prepare("вайбкодер", { kind: "capability", keys: [] });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: "capability", phrase: "вайбкодер", nodeIds: [] });
  });
  it("unchanged: a profession the model typed as a non-physical resource is still a capability", async () => {
    const [f] = await prepare("грузчик", { kind: "resource", keys: ["loading"] });
    expect(f!.kind).toBe("capability");
    expect(await keysOf(f!.nodeIds)).toEqual(["loading"]);
  });
});

describe("ontology_candidates: unknown concepts are queued for moderation, never auto-activated", () => {
  it("collects positive phrases without node only", () => {
    const base = { constraintType: "none" as const, resourceRole: "none" as const };
    expect(unknownConceptPhrases([
      { ...base, kind: "resource", phrase: "есть кофемашина", nodeIds: [], resourceRole: "available" },
      { ...base, kind: "capability", phrase: "вайбкодер", nodeIds: [] },
      { ...base, kind: "capability", phrase: "Вайбкодер ", nodeIds: [] },
      { ...base, kind: "resource", phrase: "есть машина", nodeIds: ["x"], resourceRole: "available" },
      { ...base, kind: "resource", phrase: "нет генератора", nodeIds: [], resourceRole: "missing" },
      { ...base, kind: "capability", phrase: "покраска", nodeIds: [], constraintType: "exclusion" },
      { ...base, kind: "exclude", phrase: "ночные смены", nodeIds: [] },
    ])).toEqual(["есть кофемашина", "вайбкодер"]);
  });
  it("records new phrases once, skips known ontology phrases and already moderated ones", async () => {
    const db = getDb();
    const tag = randomUUID().slice(0, 8);
    const fresh = `кофемашина-${tag}`, rejected = `стол-${tag}`;
    await db.insert(schema.ontologyCandidates).values({ rawPhrase: rejected, suggestedNodeIds: [], status: "rejected" });
    const nodesBefore = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ontologyNodes);
    expect(await recordOntologyCandidates([fresh, fresh.toUpperCase(), "Грузчик", rejected])).toBe(1);
    expect(await recordOntologyCandidates([fresh])).toBe(0);
    const rows = await db.select().from(schema.ontologyCandidates)
      .where(sql`lower(${schema.ontologyCandidates.rawPhrase}) in (${fresh}, ${rejected}, 'грузчик')`);
    expect(rows.map((r) => [r.rawPhrase, r.status]).sort()).toEqual([[fresh, "pending"], [rejected, "rejected"]].sort());
    const nodesAfter = await db.select({ n: sql<number>`count(*)::int` }).from(schema.ontologyNodes);
    expect(nodesAfter[0]!.n).toBe(nodesBefore[0]!.n);
    await db.delete(schema.ontologyCandidates).where(inArray(schema.ontologyCandidates.rawPhrase, [fresh, rejected]));
  });
});
