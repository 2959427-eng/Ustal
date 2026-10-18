import { describe, expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "@ustal/matching";
import { PROFILE_SOURCE_SEPARATOR as SEP } from "@ustal/database";
import { resolveRestrictionUpdates, reviewProfileText, toSupersededMarker, SUPERSEDED_KIND } from "./profile-restrictions.js";

const v = (i: number) => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0));
const DELIVERY = 0, REPAIR = 1, MOBILE = 2;
type F = Fact & { evidence: string };
const f = (o: Partial<F> & { evidence: string; phrase: string }): F => ({ kind: "capability", nodeIds: [], confidence: 1, mandatory: false, constraintType: "none", constraintScope: "whole_task", startHour: null, endHour: null, daysOfWeek: null, embedding: v(7), ...o });
const globalUntil22 = f({ kind: "availability", phrase: "не работаю после 22:00", evidence: "Не работаю после 22:00.", constraintType: "availability", endHour: 22 });
const globalLift = f({ kind: "availability", phrase: "работаю после 22:00", evidence: "Теперь работаю после 22:00.", constraintType: "lift" });
const deliveryUntil22 = f({ kind: "availability", phrase: "доставка", evidence: "Не занимаюсь доставкой после 22:00.", constraintType: "availability", constraintScope: "fact", endHour: 22, nodeIds: ["delivery"], embedding: v(DELIVERY) });
const refusal = f({ kind: "exclude", phrase: "доставка", evidence: "Не занимаюсь доставкой.", constraintType: "exclusion", nodeIds: ["delivery"], embedding: v(DELIVERY) });
const onlyIos = f({ kind: "capability", phrase: "мобильная разработка", evidence: "Делаю только iOS.", constraintType: "scope", nodeIds: ["programming"], embedding: v(MOBILE) });
const skill = (i: number, node: string, evidence: string) => f({ phrase: node, evidence, nodeIds: [node], embedding: v(i) });
const text = (...segments: string[]) => segments.join(SEP);
const resolve = (facts: F[], t: string) => resolveRestrictionUpdates(facts, t);

describe("time restrictions: lift / replace", () => {
  it("«Не работаю после 22:00» → «Теперь работаю после 22:00»: the old limit is lifted, the lift itself is not kept", () => {
    const r = resolve([globalUntil22, globalLift], text(globalUntil22.evidence, globalLift.evidence));
    expect(r.facts).toEqual([]);
    expect(r.superseded).toEqual([globalUntil22]);
  });
  it("a later message with a new limit replaces the old one", () => {
    const until23 = { ...globalUntil22, evidence: "Теперь работаю до 23:00.", endHour: 23 };
    const r = resolve([globalUntil22, until23], text(globalUntil22.evidence, until23.evidence));
    expect(r.facts).toEqual([until23]);
  });
  it("several windows in ONE message stay together; an unrelated message changes nothing", () => {
    const morning = { ...globalUntil22, evidence: "Работаю с 9 до 12", startHour: 9, endHour: 12 };
    const evening = { ...globalUntil22, evidence: "и с 14 до 18.", startHour: 14, endHour: 18 };
    expect(resolve([morning, evening], text(`${morning.evidence} ${evening.evidence}`)).facts).toHaveLength(2);
    expect(resolve([globalUntil22, skill(REPAIR, "repair", "Умею чинить технику.")], text(globalUntil22.evidence, "Умею чинить технику.")).superseded).toEqual([]);
  });
  it("a lift BEFORE the restriction does not remove it (order of messages decides)", () => {
    expect(resolve([globalLift, globalUntil22], text(globalLift.evidence, globalUntil22.evidence)).facts).toEqual([globalUntil22]);
  });
  it("lifting all-work hours does not lift a delivery-only limit, and vice versa", () => {
    expect(resolve([deliveryUntil22, globalLift], text(deliveryUntil22.evidence, globalLift.evidence)).facts).toEqual([deliveryUntil22]);
    const deliveryLift = { ...globalLift, phrase: "доставка", evidence: "Теперь доставляю и после 22:00.", constraintScope: "fact" as const, nodeIds: ["delivery"], embedding: v(DELIVERY) };
    expect(resolve([globalUntil22, deliveryLift], text(globalUntil22.evidence, deliveryLift.evidence)).facts).toEqual([globalUntil22]);
    expect(resolve([deliveryUntil22, deliveryLift], text(deliveryUntil22.evidence, deliveryLift.evidence)).facts).toEqual([]);
  });
  it("hours attached to a skill are lifted from the skill; the skill itself stays", () => {
    const deliverySkill = { ...skill(DELIVERY, "delivery", "Занимаюсь доставкой до 22:00."), endHour: 22 };
    const deliveryLift = { ...globalLift, phrase: "доставка", evidence: "Теперь доставляю и после 22:00.", constraintScope: "fact" as const, nodeIds: ["delivery"], embedding: v(DELIVERY) };
    const r = resolve([deliverySkill, deliveryLift], text(deliverySkill.evidence, deliveryLift.evidence));
    expect(r.facts).toEqual([{ ...deliverySkill, endHour: null }]);
    expect(r.superseded).toEqual([]);
  });
});

describe("work refusals and «только»", () => {
  it("an explicit lift of a refusal removes it; a lift of other work does not", () => {
    const lift = f({ phrase: "доставка", evidence: "Теперь снова занимаюсь доставкой.", constraintType: "lift", nodeIds: ["delivery"], embedding: v(DELIVERY) });
    expect(resolve([refusal, lift], text(refusal.evidence, lift.evidence)).superseded).toEqual([refusal]);
    const other = { ...lift, phrase: "ремонт", evidence: "Теперь чиню технику.", nodeIds: ["repair"], embedding: v(REPAIR) };
    const r = resolve([refusal, other], text(refusal.evidence, other.evidence));
    expect(r.superseded).toEqual([]);
    expect(r.facts[0]).toEqual(refusal);
  });
  it("a lift of a refusal also states the activity: it becomes a skill unless that skill is already there", () => {
    const lift = f({ phrase: "доставка", evidence: "Теперь занимаюсь доставкой.", constraintType: "lift", nodeIds: ["delivery"], embedding: v(DELIVERY) });
    expect(resolve([refusal, lift], text(refusal.evidence, lift.evidence)).facts).toEqual([{ ...lift, constraintType: "none", constraintScope: "whole_task" }]);
    const deliverySkill = skill(DELIVERY, "delivery", "Теперь занимаюсь доставкой.");
    expect(resolve([refusal, deliverySkill, lift], text(refusal.evidence, lift.evidence)).facts).toEqual([deliverySkill]);
  });
  it("the lifted-restriction history keeps its activity, area and hour for the review guard", () => {
    expect(toSupersededMarker(refusal)).toMatchObject({ kind: SUPERSEDED_KIND, nodeIds: ["delivery"], resourceCapacity: { kind: "lifted:work", value: null } });
    expect(toSupersededMarker(globalUntil22)).toMatchObject({ endHour: null, resourceCapacity: { kind: "lifted:time_global", value: 22, unit: "hour" } });
  });
  it("«Только iOS» → «Теперь делаю и Android»: the only-limit is lifted, the new skill stays", () => {
    const android = skill(MOBILE, "programming", "Теперь делаю и Android.");
    const lift = f({ phrase: "мобильная разработка", evidence: "Теперь делаю и Android.", constraintType: "lift", nodeIds: ["programming"], embedding: v(MOBILE) });
    const r = resolve([onlyIos, android, lift], text(onlyIos.evidence, android.evidence));
    expect(r.facts).toEqual([android]);
    expect(r.superseded).toEqual([onlyIos]);
  });
  it("«Только iOS» → «Только iOS и Android»: the new only-limit replaces the old one", () => {
    const both = { ...onlyIos, evidence: "Теперь только iOS и Android." };
    expect(resolve([onlyIos, both], text(onlyIos.evidence, both.evidence)).facts).toEqual([both]);
  });
});

describe("history and source review", () => {
  it("a lifted restriction is kept as an inert history fact that matching ignores", () => {
    const marker = toSupersededMarker(globalUntil22);
    expect(marker).toMatchObject({ kind: SUPERSEDED_KIND, constraintType: "none", nodeIds: [], startHour: null, endHour: null, evidence: globalUntil22.evidence });
    const repairAfter23 = [f({ phrase: "repair", evidence: "x", nodeIds: ["repair"], embedding: v(REPAIR) }), f({ kind: "availability", phrase: "после 23", evidence: "y", constraintType: "availability", startHour: 23 })];
    const profileSkill = skill(REPAIR, "repair", "Умею чинить технику.");
    const run = (caps: Fact[]) => evaluateSemantic({ capabilities: caps, requirements: repairAfter23, relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false });
    expect(run([profileSkill, globalUntil22]).reason).toBe("outside_availability"); // before the lift
    expect(run([profileSkill, marker]).matchType).toBe("exact"); // after the lift: no longer affects matching
  });
  it("the review text drops lifted statements, keeps everything else and is untouched without lifts", () => {
    const src = text("Умею чинить технику. Не работаю после 22:00.", "Теперь работаю после 22:00.");
    const out = reviewProfileText(src, [skill(REPAIR, "repair", "Умею чинить технику."), toSupersededMarker(globalUntil22)]);
    expect(out).not.toContain("Не работаю после 22:00.");
    expect(out).toContain("Умею чинить технику.");
    expect(out).toContain("Теперь работаю после 22:00.");
    expect(reviewProfileText(src, [skill(REPAIR, "repair", "Умею чинить технику.")])).toBe(src);
    // Repeated later as a live restriction -> stays visible. Since 2026-10-17 a message whose quote is shared by a live
    // and an inactive fact is rendered from the live structured state (Codex audit, shared evidence), not as the raw quote.
    expect(reviewProfileText(src, [toSupersededMarker(globalUntil22), globalUntil22])).toMatch(/Доступность: до 22:00\./);
  });
});

it("the evidence-span separator in @ustal/ai equals the profile source separator", async () => {
  const { PROFILE_MESSAGE_SEPARATOR } = await import("@ustal/ai");
  expect(PROFILE_MESSAGE_SEPARATOR).toBe(SEP);
});

it("an activity lift typed as a skill lift also lifts that activity's hours («теперь доставляю и после 22:00»)", () => {
  const lift = f({ phrase: "доставка", evidence: "Теперь доставляю и после 22:00.", constraintType: "lift", nodeIds: ["delivery"], embedding: v(DELIVERY) });
  const r = resolveRestrictionUpdates([deliveryUntil22, lift], text(deliveryUntil22.evidence, lift.evidence));
  expect(r.superseded).toEqual([deliveryUntil22]);
  // global hours of all work are not touched by an activity lift
  expect(resolveRestrictionUpdates([globalUntil22, lift], text(globalUntil22.evidence, lift.evidence)).facts).toContainEqual(globalUntil22);
});

it("«Теперь работаю до 18:00» typed as a lift with hours is a replacement: the new limit stays", () => {
  const until18 = f({ kind: "availability", phrase: "работаю до 18:00", evidence: "Теперь работаю до 18:00.", constraintType: "lift", endHour: 18 });
  const r = resolveRestrictionUpdates([globalUntil22, until18], text(globalUntil22.evidence, until18.evidence));
  expect(r.superseded).toEqual([globalUntil22]);
  expect(r.facts).toEqual([{ ...until18, constraintType: "availability" }]);
  expect(r.lifts).toEqual([]);
});
