import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, PROFILE_SOURCE_SEPARATOR as SEP, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { evaluateSemantic } from "@ustal/matching";
import { prepareDocument } from "./semantic.js";
import { reviewProfileText } from "./profile-restrictions.js";
assertLocalTestDatabase();
afterAll(async () => { await getSql().end(); });

/** Cumulative profile text through the real prepareDocument (ontology from the seed DB; AI output injected). */
const fact = (o: Record<string, unknown>) => ({
  kind: "capability", subjectType: "unspecified", canonicalKeys: [], confidence: 0.95, mandatory: false, constraintType: "none",
  constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, ...o,
});
async function prepare(text: string, facts: Record<string, unknown>[]) {
  const spy = vi.spyOn(mockProviders.extraction, "normalizeMatching").mockResolvedValue({
    data: { facts: facts.map(fact) }, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0,
  } as never);
  try { return (await prepareDocument("profile", text, {}, randomUUID())).facts; } finally { spy.mockRestore(); }
}
const keys = async (ids: string[]) => ids.length ? (await getDb().select({ k: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes).where(inArray(schema.ontologyNodes.id, ids))).map((r) => r.k) : [];
const live = <T extends { kind: string }>(facts: T[]) => facts.filter((f) => (f.kind as string) !== "superseded");

describe("profile restriction updates through prepareDocument", () => {
  it("time: «Не работаю после 22:00» then «Теперь работаю после 22:00» → no live time limit, history kept, matching unaffected", async () => {
    const t = ["Умею ремонтировать бытовую технику. Не работаю после 22:00.", "Теперь работаю после 22:00."].join(SEP);
    const facts = await prepare(t, [
      { phrase: "ремонт бытовой техники", evidence: "Умею ремонтировать бытовую технику.", canonicalKeys: ["appliance_repair"] },
      { kind: "availability", phrase: "не работаю после 22:00", evidence: "Не работаю после 22:00.", constraintType: "availability", endHour: 22 },
      { kind: "availability", phrase: "работаю после 22:00", evidence: "Теперь работаю после 22:00.", constraintType: "lift" },
    ]);
    expect(live(facts).filter((f) => f.kind === "availability")).toEqual([]);
    expect(facts.filter((f) => f.constraintType === "lift")).toEqual([]);
    expect(facts.find((f) => (f.kind as string) === "superseded")).toMatchObject({ evidence: "Не работаю после 22:00.", endHour: null });
    // Matching after the lift: repair at 23:00 is not rejected; the review no longer sees the old limit.
    const skill = facts.find((f) => f.kind === "capability")!;
    const r = evaluateSemantic({ capabilities: facts, requirements: [{ ...skill, startHour: 23, constraintScope: "whole_task" }], relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false });
    expect(r.reason).not.toBe("outside_availability");
    expect(reviewProfileText(t, facts)).not.toContain("Не работаю после 22:00.");
  });

  it("work: «Не занимаюсь доставкой» then «Теперь занимаюсь доставкой» → refusal lifted, the skill keeps its delivery node", async () => {
    const t = ["Не занимаюсь доставкой.", "Раньше не занимался доставкой, теперь занимаюсь."].join(SEP);
    const facts = await prepare(t, [
      { kind: "exclude", phrase: "доставка", evidence: "Не занимаюсь доставкой.", constraintType: "exclusion", canonicalKeys: ["delivery"] },
      { phrase: "доставка", evidence: "Раньше не занимался доставкой, теперь занимаюсь.", canonicalKeys: ["delivery"] },
    ]);
    expect(live(facts).filter((f) => f.kind === "exclude")).toEqual([]);
    const skill = live(facts).find((f) => f.kind === "capability")!;
    expect(await keys(skill.nodeIds)).toEqual(["delivery"]);
    expect(facts.find((f) => (f.kind as string) === "superseded")?.evidence).toBe("Не занимаюсь доставкой.");
  });

  it("work: the refusal still wins when it is the NEWER statement", async () => {
    const t = ["Занимаюсь доставкой.", "Больше не занимаюсь доставкой."].join(SEP);
    const facts = await prepare(t, [
      { phrase: "доставка", evidence: "Занимаюсь доставкой.", canonicalKeys: ["delivery"] },
      { kind: "exclude", phrase: "доставка", evidence: "Больше не занимаюсь доставкой.", constraintType: "exclusion", canonicalKeys: ["delivery"], refusalIntent: "revoke" },
    ]);
    expect(live(facts).map((f) => f.kind)).toEqual(["exclude"]);
  });

  it("only: «Только iOS» then «Теперь делаю и Android» → the only-limit is lifted, Android stays a skill", async () => {
    const t = ["Мобильный разработчик, делаю только iOS.", "Теперь делаю и Android."].join(SEP);
    const facts = await prepare(t, [
      { phrase: "мобильная разработка", evidence: "Мобильный разработчик, делаю только iOS.", constraintType: "scope", canonicalKeys: ["programming"] },
      { phrase: "разработка Android-приложений", evidence: "Теперь делаю и Android.", canonicalKeys: ["programming"] },
      { phrase: "мобильная разработка", evidence: "Теперь делаю и Android.", constraintType: "lift", canonicalKeys: ["programming"] },
    ]);
    expect(live(facts).filter((f) => f.constraintType === "scope")).toEqual([]);
    expect(live(facts).map((f) => f.phrase)).toEqual(["разработка Android-приложений"]);
    expect(reviewProfileText(t, facts)).not.toContain("только iOS");
  });

  it("only: «Только iOS» then «Только iOS и Android» → replaced by the new limit", async () => {
    const t = ["Делаю только iOS.", "Теперь только iOS и Android."].join(SEP);
    const facts = await prepare(t, [
      { phrase: "мобильная разработка", evidence: "Делаю только iOS.", constraintType: "scope", canonicalKeys: ["programming"] },
      { phrase: "мобильная разработка", evidence: "Теперь только iOS и Android.", constraintType: "scope", canonicalKeys: ["programming"] },
    ]);
    expect(live(facts).filter((f) => f.constraintType === "scope").map((f) => f.evidence)).toEqual(["Теперь только iOS и Android."]);
  });

  it("no lift → nothing changes (no guessing)", async () => {
    const t = ["Не работаю после 22:00.", "Умею ремонтировать бытовую технику."].join(SEP);
    const facts = await prepare(t, [
      { kind: "availability", phrase: "не работаю после 22:00", evidence: "Не работаю после 22:00.", constraintType: "availability", endHour: 22 },
      { phrase: "ремонт бытовой техники", evidence: "Умею ремонтировать бытовую технику.", canonicalKeys: ["appliance_repair"] },
    ]);
    expect(facts.some((f) => (f.kind as string) === "superseded")).toBe(false);
    expect(facts.find((f) => f.kind === "availability")).toMatchObject({ endHour: 22 });
  });
});
