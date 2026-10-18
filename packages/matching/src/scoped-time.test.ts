import { describe, expect, it } from "vitest";
import { evaluateSemantic, type Fact, type Relation } from "./semantic.js";

/**
 * 2026-10-06: «Не занимаюсь доставкой после 22:00» limits delivery only. A global limit
 * («после 22:00 вообще не работаю») still applies to every order.
 */
const v = (i: number) => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0));
const DELIVERY = 0, REPAIR = 1, EVENTS = 2, UNRELATED = 5;
const node = ["delivery", "appliance_repair", "events"];
const cap = (i: number, extra: Partial<Fact> = {}): Fact => ({ kind: "capability", phrase: node[i]!, nodeIds: [node[i]!], confidence: 1, mandatory: false, embedding: v(i), ...extra });
const after23: Fact = { kind: "availability", phrase: "после 23:00", nodeIds: [], confidence: 1, mandatory: false, constraintType: "availability", constraintScope: "whole_task", startHour: 23, endHour: null, embedding: v(7) };
const profile = (limit: Fact) => [cap(DELIVERY), cap(REPAIR), cap(EVENTS), limit];
const deliveryOnlyUntil22: Fact = { kind: "availability", phrase: "доставка", nodeIds: ["delivery"], confidence: 1, mandatory: false, constraintType: "availability", constraintScope: "fact", startHour: null, endHour: 22, embedding: v(DELIVERY) };
const globalUntil22: Fact = { kind: "availability", phrase: "после 22:00 не работаю", nodeIds: [], confidence: 1, mandatory: false, constraintType: "availability", constraintScope: "whole_task", startHour: null, endHour: 22, embedding: v(6) };
const run = (caps: Fact[], reqs: Fact[], extra: Partial<Parameters<typeof evaluateSemantic>[0]> = {}, relations: Relation[] = []) =>
  evaluateSemantic({ capabilities: caps, requirements: reqs, relations, documentSimilarity: 0.9, riskLevel: 0, regulated: false, ...extra });

describe("activity-scoped time limit («не занимаюсь доставкой после 22:00»)", () => {
  it("delivery after 23:00 -> hard reject", () =>
    expect(run(profile(deliveryOnlyUntil22), [cap(DELIVERY), after23]).reason).toBe("outside_availability"));
  it("delivery at 23:00 by the order's local hour -> hard reject", () =>
    expect(run(profile(deliveryOnlyUntil22), [cap(DELIVERY)], { localHour: 23 }).reason).toBe("outside_availability"));
  it("delivery before 22:00 -> not rejected by this rule", () =>
    expect(run(profile(deliveryOnlyUntil22), [cap(DELIVERY)], { localHour: 18 }).matchType).toBe("exact"));
  it("appliance repair after 23:00 -> not rejected", () =>
    expect(run(profile(deliveryOnlyUntil22), [cap(REPAIR), after23]).matchType).toBe("exact"));
  it("event setup at 23:00 -> not rejected", () =>
    expect(run(profile(deliveryOnlyUntil22), [cap(EVENTS)], { localHour: 23 }).matchType).toBe("exact"));
  it("covers a narrower child activity of the limited one (courier is_a delivery)", () =>
    expect(run(profile(deliveryOnlyUntil22), [{ ...cap(DELIVERY), nodeIds: ["courier"] }, after23], {},
      [{ fromNodeId: "courier", toNodeId: "delivery", relationType: "is_a" }]).reason).toBe("outside_availability"));
  it("unclear scope (no node, unrelated meaning) is never widened to all work", () =>
    expect(run(profile({ ...deliveryOnlyUntil22, nodeIds: [], embedding: v(UNRELATED) }), [cap(REPAIR), after23]).matchType).toBe("exact"));
});

describe("legacy stored form: time-bounded refusal (kind=exclude with hours)", () => {
  const legacy: Fact = { kind: "exclude", phrase: "Не занимаюсь доставкой после 22:00.", nodeIds: [], confidence: 1, mandatory: false, constraintType: "availability", constraintScope: "whole_task", startHour: null, endHour: 22, embedding: v(DELIVERY) };
  it("is not a global limit: repair after 23:00 is not rejected", () =>
    expect(run(profile({ ...legacy, embedding: v(UNRELATED) }), [cap(REPAIR), after23]).matchType).toBe("exact"));
  it("still limits the same activity by meaning: delivery after 23:00 is rejected", () =>
    expect(run(profile(legacy), [cap(DELIVERY), after23]).reason).toBe("outside_availability"));
  it("is not a total refusal: delivery in the daytime is not an explicit exclusion", () =>
    expect(run(profile({ ...legacy, nodeIds: ["delivery"] }), [cap(DELIVERY)], { localHour: 15 }).matchType).toBe("exact"));
});

describe("global time limit («после 22:00 вообще не работаю») keeps applying to all work", () => {
  it.each([[DELIVERY], [REPAIR], [EVENTS]])("activity %s after 23:00 -> hard reject", (i) =>
    expect(run(profile(globalUntil22), [cap(i), after23]).reason).toBe("outside_availability"));
  it("work in the daytime -> not rejected", () =>
    expect(run(profile(globalUntil22), [cap(REPAIR)], { localHour: 12 }).matchType).toBe("exact"));
  it("both limits: a global window is not widened by an activity window and vice versa", () => {
    const morningOnlyGlobal = { ...globalUntil22, startHour: 8, endHour: 23 };
    expect(run([...profile(deliveryOnlyUntil22), morningOnlyGlobal], [cap(DELIVERY)], { localHour: 22 }).reason).toBe("outside_availability");
    expect(run([...profile(deliveryOnlyUntil22), morningOnlyGlobal], [cap(REPAIR)], { localHour: 22 }).matchType).toBe("exact");
  });
});

describe("a point-in-time order («доставка в 18:00» -> 18..18)", () => {
  const at18: Fact = { ...after23, phrase: "в 18:00", startHour: 18, endHour: 18 };
  it("is 18:00 only, not the whole day: delivery at 18:00 is within «delivery until 22:00»", () =>
    expect(run(profile(deliveryOnlyUntil22), [cap(DELIVERY), at18]).matchType).toBe("exact"));
  it("still conflicts with a limit that excludes 18:00", () =>
    expect(run(profile({ ...deliveryOnlyUntil22, endHour: 17 }), [cap(DELIVERY), at18]).reason).toBe("outside_availability"));
});

describe("source-review conflict quoting an activity-scoped time limit", () => {
  const limit = { ...deliveryOnlyUntil22, evidence: "Не занимаюсь доставкой после 22:00." };
  const review = (profileEvidence: string) => ({ compatible: false, confidence: 0.95, reason: "time conflict",
    hardConflict: { kind: "numeric", profileEvidence, orderEvidence: "после 23:00" } });
  it("does not reject different work: the review is treated as unavailable, deterministic rules decide", () => {
    const r = run(profile(limit), [cap(REPAIR), after23], { semanticReview: review("Не занимаюсь доставкой после 22:00") });
    expect(r.matchType).toBe("exact");
    expect(r.trace).toMatchObject({ review_conflict_ignored: "inapplicable_activity_time_limit", review_unverified: true });
  });
  it("still rejects the limited activity itself", () =>
    expect(run(profile(limit), [cap(DELIVERY), after23], { semanticReview: review("Не занимаюсь доставкой после 22:00") }).classification).toBe("reject"));
  it("a conflict quoting anything else is untouched", () =>
    expect(run(profile(limit), [cap(REPAIR), after23], { semanticReview: review("Работаю только с iOS") }).reason).toBe("numeric_mismatch"));
  it("a global time limit quoted by the review is untouched", () =>
    expect(run(profile({ ...globalUntil22, evidence: "После 22:00 вообще не работаю." }), [cap(REPAIR)], { semanticReview: review("После 22:00 вообще не работаю") }).reason).toBe("numeric_mismatch"));
});

it("a non-time limit labelled availability (blind BH-046: «работа на высоте до 10м») is never treated as a time limit", () => {
  const height: Fact = { kind: "resource", phrase: "работа на высоте до 10м", nodeIds: [], confidence: 1, mandatory: false, constraintType: "availability", constraintScope: "fact", evidence: '{"skill":"кровельщик","height":"до 10м"}', embedding: v(UNRELATED) };
  const r = run([cap(REPAIR), height], [cap(REPAIR)], { semanticReview: { compatible: false, confidence: 0.95, reason: "height", hardConflict: { kind: "numeric", profileEvidence: '{"skill":"кровельщик","height":"до 10м"}', orderEvidence: "40 м" } } });
  expect(r.reason).toBe("numeric_mismatch");
});

it("the review guard never ignores a non-time conflict quoted from the same whole-message evidence", () => {
  const msg = "Делаю только iOS. Не занимаюсь доставкой после 22:00.";
  const limit = { ...deliveryOnlyUntil22, evidence: msg };
  const scope = { compatible: false, confidence: 0.95, reason: "only iOS", hardConflict: { kind: "scope", profileEvidence: msg, orderEvidence: "Android" } };
  expect(run([cap(REPAIR), limit], [cap(REPAIR)], { semanticReview: scope }).reason).toBe("scope_mismatch");
  const height = { ...scope, hardConflict: { kind: "numeric", profileEvidence: "кровельщик до 10м", orderEvidence: "40 м" } };
  expect(run([cap(REPAIR), { ...limit, evidence: "кровельщик до 10м. Не занимаюсь доставкой после 22:00." }], [cap(REPAIR)], { semanticReview: height }).reason).toBe("numeric_mismatch");
});
