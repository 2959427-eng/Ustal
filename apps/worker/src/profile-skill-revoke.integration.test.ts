import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, PROFILE_SOURCE_SEPARATOR as SEP, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { evaluateSemantic } from "@ustal/matching";
import { prepareDocument } from "./semantic.js";
import { isRevokedCapability } from "./profile-negatives.js";
assertLocalTestDatabase();
afterAll(async () => { await getSql().end(); });

/**
 * Отзыв навыка vs ограничение (2026-10-06): накопительный профиль через настоящий prepareDocument (ontology из
 * seed, ответ нормализации подставлен — refusalIntent задаёт модель), затем решение matching (evaluateSemantic).
 */
const fact = (o: Record<string, unknown>) => ({
  kind: "capability", subjectType: "unspecified", canonicalKeys: [], confidence: 0.95, mandatory: false, constraintType: "none",
  constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, refusalIntent: null, ...o,
});
async function prepare(kind: "profile" | "order", text: string, facts: Record<string, unknown>[]) {
  const spy = vi.spyOn(mockProviders.extraction, "normalizeMatching").mockResolvedValue({
    data: { facts: facts.map(fact) }, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0,
  } as never);
  try { return (await prepareDocument(kind, text, {}, randomUUID())).facts; } finally { spy.mockRestore(); }
}
const keys = async (ids: string[]) => ids.length ? (await getDb().select({ k: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes).where(inArray(schema.ontologyNodes.id, ids))).map((r) => r.k) : [];
const live = <T extends { kind: string }>(facts: T[]) => facts.filter((f) => (f.kind as string) !== "superseded");
const skills = async (facts: { kind: string; nodeIds: string[] }[]) =>
  (await Promise.all(live(facts).filter((f) => f.kind === "capability").map((f) => keys(f.nodeIds)))).flat().sort();
async function decide(profile: Awaited<ReturnType<typeof prepare>>, order: string, key: string, hour: number | null = null) {
  // Order time is a separate availability fact (a point in time: start = end), as normalization returns it.
  const req = await prepare("order", order, [{ phrase: order, evidence: order, canonicalKeys: [key] },
    ...(hour == null ? [] : [{ kind: "availability", phrase: order, evidence: order, constraintType: "availability", startHour: hour, endHour: hour }])]);
  return evaluateSemantic({ capabilities: profile, requirements: req, relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false });
}

const DIG = "Могу копать.";
const digSkill = { phrase: "копать", evidence: DIG, canonicalKeys: ["digging"] };

describe("skill revoke vs restriction (cumulative profile)", () => {
  it("1. «Могу копать» → «Не хочу больше копать»: the skill is not active, no restriction is shown, digging orders are not matched", async () => {
    const t = [DIG, "Не хочу больше копать."].join(SEP);
    // The live model returns this refusal as kind=capability + constraintType=exclusion, scope=fact.
    const facts = await prepare("profile", t, [digSkill,
      { kind: "capability", phrase: "копать", evidence: "Не хочу больше копать.", constraintType: "exclusion", constraintScope: "fact", canonicalKeys: ["digging"], refusalIntent: "revoke" }]);
    expect(await skills(facts)).toEqual([]);
    const refusal = live(facts).filter((f) => f.constraintType === "exclusion");
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatchObject({ kind: "exclude", constraintScope: "whole_task" });
    expect(isRevokedCapability(refusal[0]!)).toBe(true);
    const r = await decide(facts, "Нужно выкопать яму", "digging");
    expect(r.classification).toBe("reject");
    expect(r.reason).toBe("explicit_exclusion");
  });

  it("2. «Больше не занимаюсь копкой» (the refusal named differently, same activity) revokes the skill", async () => {
    const t = [DIG, "Больше не занимаюсь копкой."].join(SEP);
    const facts = await prepare("profile", t, [digSkill,
      { kind: "exclude", phrase: "копка", evidence: "Больше не занимаюсь копкой.", constraintType: "exclusion", canonicalKeys: ["digging"], refusalIntent: "revoke" }]);
    expect(await skills(facts)).toEqual([]);
    expect(live(facts).filter(isRevokedCapability)).toHaveLength(1);
  });

  it("3. «Копать умею, но пока заказы не беру»: the skill stays and a restriction rejects digging orders", async () => {
    const msg = "Копать умею, но пока заказы не беру.";
    const facts = await prepare("profile", [DIG, msg].join(SEP), [digSkill,
      { phrase: "копать", evidence: msg, canonicalKeys: ["digging"] },
      { kind: "exclude", phrase: "копать", evidence: msg, constraintType: "exclusion", constraintScope: "fact", canonicalKeys: ["digging"], refusalIntent: "restriction" }]);
    expect(await skills(facts)).toContain("digging");
    const refusal = live(facts).find((f) => f.kind === "exclude")!;
    expect(refusal).toMatchObject({ constraintScope: "whole_task" });
    expect(isRevokedCapability(refusal)).toBe(false);
    expect((await decide(facts, "Нужно выкопать траншею", "digging")).reason).toBe("explicit_exclusion");
  });

  it("4. «Не копаю после 18:00»: the skill stays, only digging gets a time limit", async () => {
    const msg = "Не копаю после 18:00.";
    const facts = await prepare("profile", [DIG, msg].join(SEP), [digSkill,
      { kind: "exclude", phrase: "копать", evidence: msg, constraintType: "exclusion", constraintScope: "fact", canonicalKeys: ["digging"], endHour: 18, refusalIntent: "restriction" }]);
    expect(await skills(facts)).toEqual(["digging"]);
    expect(live(facts).find((f) => f.endHour === 18)).toMatchObject({ kind: "availability", constraintScope: "fact" });
    expect((await decide(facts, "Выкопать яму в 20:00", "digging", 20)).reason).toBe("outside_availability");
    expect((await decide(facts, "Выкопать яму в 10:00", "digging", 10)).classification).not.toBe("reject");
  });

  it("5. «Могу ремонтировать бытовую технику» → «Холодильники больше не ремонтирую»: general repair stays", async () => {
    const skill = { phrase: "ремонт бытовой техники", evidence: "Могу ремонтировать бытовую технику.", canonicalKeys: ["appliance_repair"] };
    const msg = "Холодильники больше не ремонтирую.";
    const t = [skill.evidence, msg].join(SEP);
    for (const refusalIntent of ["restriction", "revoke"]) {
      // Even a model that wrongly calls a narrower refusal a revoke cannot remove the broader skill.
      const facts = await prepare("profile", t, [skill,
        { kind: "exclude", phrase: "ремонт холодильников", evidence: msg, constraintType: "exclusion", canonicalKeys: ["refrigerator_repair"], refusalIntent }]);
      expect(await skills(facts)).toEqual(["appliance_repair"]);
      expect((await decide(facts, "Починить холодильник", "refrigerator_repair")).reason).toBe("explicit_exclusion");
      expect((await decide(facts, "Починить стиральную машину", "washing_machine_repair")).reason).not.toBe("explicit_exclusion");
    }
  });

  it("6. revoke → «Снова беру заказы на копку»: the skill is active again and the old revoke no longer applies", async () => {
    const back = "Снова беру заказы на копку.";
    const t = [DIG, "Не хочу больше копать.", back].join(SEP);
    const facts = await prepare("profile", t, [digSkill,
      { kind: "exclude", phrase: "копать", evidence: "Не хочу больше копать.", constraintType: "exclusion", canonicalKeys: ["digging"], refusalIntent: "revoke" },
      { phrase: "копка", evidence: back, canonicalKeys: ["digging"] }]);
    expect(await skills(facts)).toEqual(["digging"]);
    expect(live(facts).filter((f) => f.constraintType === "exclusion")).toEqual([]);
    const r = await decide(facts, "Нужно выкопать яму", "digging");
    expect(r.classification).not.toBe("reject");
  });

  it("7. after a revoke a refusal never counts as a skill (no node coverage, no positive retrieval text)", async () => {
    const facts = await prepare("profile", "Не хочу больше копать.", [
      { kind: "capability", phrase: "копать", evidence: "Не хочу больше копать.", constraintType: "exclusion", constraintScope: "fact", canonicalKeys: ["digging"], refusalIntent: "revoke" }]);
    expect(live(facts).filter((f) => f.kind === "capability")).toEqual([]);
    const r = await decide(facts, "Нужно выкопать яму", "digging");
    expect(r.matchType).toBeNull();
  });

  it("8. a temporary restriction without restating the skill keeps the earlier skill", async () => {
    const msg = "Пока не хочу брать заказы на копку.";
    const facts = await prepare("profile", [DIG, msg].join(SEP), [digSkill,
      { kind: "exclude", phrase: "копка", evidence: msg, constraintType: "exclusion", canonicalKeys: ["digging"], refusalIntent: "restriction" }]);
    expect(await skills(facts)).toEqual(["digging"]);
    expect(live(facts).filter((f) => f.kind === "exclude")).toHaveLength(1);
  });

  it("8b. a refusal without intent (ambiguous) never deletes a skill", async () => {
    const msg = "Копать не хочу.";
    const facts = await prepare("profile", [DIG, msg].join(SEP), [digSkill,
      { kind: "exclude", phrase: "копать", evidence: msg, constraintType: "exclusion", canonicalKeys: ["digging"] }]);
    expect(await skills(facts)).toEqual(["digging"]);
  });

  it("10. a revoke touches only that skill: other skills and resources of the profile stay", async () => {
    const first = "Могу копать. Умею красить стены. Есть машина.";
    const msg = "Не хочу больше копать.";
    const facts = await prepare("profile", [first, msg].join(SEP), [
      { phrase: "копать", evidence: first, canonicalKeys: ["digging"] },
      { phrase: "покраска стен", evidence: first, canonicalKeys: ["painting"] },
      { kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase: "машина", evidence: first, canonicalKeys: ["car"] },
      { kind: "exclude", phrase: "копать", evidence: msg, constraintType: "exclusion", canonicalKeys: ["digging"], refusalIntent: "revoke" }]);
    expect(await skills(facts)).toEqual(["painting"]);
    const car = live(facts).find((f) => f.kind === "resource")!;
    expect(await keys(car.nodeIds)).toEqual(["car"]);
  });
  it("the model put refusalIntent on the skill fact itself instead of a separate refusal (seen live)", async () => {
    const restricted = await prepare("profile", [DIG, "Копать умею, но сейчас такие заказы не беру."].join(SEP), [
      { ...digSkill, refusalIntent: "restriction" }]);
    expect(await skills(restricted)).toEqual(["digging"]);
    expect((await decide(restricted, "Нужно выкопать яму", "digging")).reason).toBe("explicit_exclusion");
    const revoked = await prepare("profile", [DIG, "Не хочу, чтобы мне предлагали копать."].join(SEP), [
      { ...digSkill, refusalIntent: "revoke" }]);
    expect(await skills(revoked)).toEqual([]);
    expect((await decide(revoked, "Нужно выкопать яму", "digging")).reason).toBe("explicit_exclusion");
  });
  it("«Купил генератор снова» typed by the model as a lift is an available resource again (newer than «продал»)", async () => {
    const t = ["Есть генератор.", "Генератор я продал.", "Купил генератор снова."].join(SEP);
    const facts = await prepare("profile", t, [
      { kind: "resource", subjectType: "physical_resource", resourceRole: "available", phrase: "генератор", evidence: "Есть генератор." },
      { kind: "resource", subjectType: "physical_resource", resourceRole: "missing", phrase: "генератор", evidence: "Генератор я продал." },
      { kind: "resource", subjectType: "physical_resource", resourceRole: "available", constraintType: "lift", phrase: "генератор", evidence: "Купил генератор снова." }]);
    expect(live(facts).map((f) => [f.kind, f.resourceRole, f.constraintType])).toEqual([["resource", "available", "none"]]);
  });
  it("an asset the model returned as a skill («самолет»: capability + resourceRole=available) stays a resource (seen live)", async () => {
    const t = ["Ремонтирую бытовую технику. Есть самолет.", "Больше не ремонтирую бытовую технику."].join(SEP);
    const facts = await prepare("profile", t, [
      { phrase: "самолет", evidence: "Ремонтирую бытовую технику. Есть самолет.", resourceRole: "available" },
      { phrase: "кофемашина", evidence: "Ремонтирую бытовую технику. Есть самолет.", subjectType: "physical_resource" }]);
    expect(live(facts).map((f) => [f.kind, f.phrase])).toEqual([["resource", "самолет"], ["resource", "кофемашина"]]);
  });
  it("hours copied by the model from «Работаю до 21:00» onto a revoke are dropped: the revoke works (seen live)", async () => {
    const t = [DIG + " Ремонтирую бытовую технику.", "Работаю до 21:00.", "Не хочу больше копать."].join(SEP);
    const facts = await prepare("profile", t, [
      { ...digSkill, evidence: DIG + " Ремонтирую бытовую технику.", endHour: 21 },
      { phrase: "ремонт бытовой техники", evidence: DIG + " Ремонтирую бытовую технику.", canonicalKeys: ["appliance_repair"], endHour: 21 },
      { kind: "availability", phrase: "работаю до 21:00", evidence: "Работаю до 21:00.", constraintType: "availability", endHour: 21 },
      { kind: "exclude", phrase: "копать", evidence: "Не хочу больше копать.", constraintType: "exclusion", canonicalKeys: ["digging"], endHour: 21, refusalIntent: "revoke" }]);
    expect(await skills(facts)).toEqual(["appliance_repair"]);
    expect(live(facts).filter((f) => f.endHour === 21).map((f) => f.phrase)).toEqual(["работаю до 21:00"]);
    expect(live(facts).filter(isRevokedCapability)).toHaveLength(1);
  });
});
