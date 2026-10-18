import { describe, expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";

/**
 * 2026-10-06: a restriction the user lifted himself is stored as inert history (kind="superseded").
 * The source review sees the whole old message and may still quote it — such a conflict must not
 * bring the lifted restriction back; a live restriction of the same area still wins.
 */
const v = (i: number) => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0));
const DELIVERY = 0, REPAIR = 1, MOBILE = 2;
const cap = (i: number, node: string, extra: Partial<Fact> = {}): Fact => ({ kind: "capability", phrase: node, nodeIds: [node], confidence: 1, mandatory: false, embedding: v(i), ...extra });
const lifted = (area: string, node: string | null, i: number, evidence: string, hour: number | null = null): Fact => ({
  kind: "superseded", phrase: node ?? "время", nodeIds: node ? [node] : [], confidence: 1, mandatory: false, embedding: v(i), evidence,
  constraintType: "none", resourceCapacity: { value: hour, unit: hour == null ? null : "hour", kind: `lifted:${area}` },
});
const review = (kind: string, profileEvidence: string) => ({ compatible: false, confidence: 0.95, reason: "old restriction", hardConflict: { kind, profileEvidence, orderEvidence: "order" } });
const run = (caps: Fact[], reqs: Fact[], semanticReview?: ReturnType<typeof review>) =>
  evaluateSemantic({ capabilities: caps, requirements: reqs, relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false, semanticReview });
const MSG1 = "Умею ремонтировать бытовую технику. Не занимаюсь доставкой.";

describe("source-review conflict quoting a restriction the user lifted", () => {
  it("work: «Не занимаюсь доставкой» → «теперь занимаюсь»: an exclusion conflict quoting the old message is ignored", () => {
    const r = run([cap(REPAIR, "repair", { evidence: MSG1 }), cap(DELIVERY, "delivery"), lifted("work", "delivery", DELIVERY, MSG1)], [cap(DELIVERY, "delivery")], review("exclusion", "Не занимаюсь доставкой."));
    expect(r.matchType).toBe("exact");
    expect(r.trace).toMatchObject({ review_conflict_ignored: "restriction_lifted_by_user", review_unverified: true });
  });
  it("…but a live refusal of the same work keeps the conflict", () => {
    const liveRefusal: Fact = { kind: "exclude", phrase: "доставка", nodeIds: ["courier"], confidence: 1, mandatory: false, constraintType: "exclusion", constraintScope: "fact", embedding: v(DELIVERY), evidence: "Курьером не работаю." };
    const r = run([cap(DELIVERY, "delivery"), liveRefusal, lifted("work", "delivery", DELIVERY, MSG1)], [cap(DELIVERY, "delivery")], review("exclusion", "Не занимаюсь доставкой."));
    expect(r.classification).toBe("reject");
  });
  it("scope: «только iOS» → «делаю и Android»: a scope conflict is ignored; another kind of conflict is not", () => {
    const msg = "Мобильный разработчик, делаю только iOS-приложения.";
    const caps = [cap(MOBILE, "programming"), lifted("scope", "programming", MOBILE, msg)];
    expect(run(caps, [cap(MOBILE, "programming")], review("scope", "делаю только iOS-приложения")).matchType).toBe("exact");
    expect(run(caps, [cap(MOBILE, "programming")], review("location", "делаю только iOS-приложения")).reason).toBe("location_mismatch");
  });
  it("time: the lifted «после 22:00» is not brought back; a numeric conflict about something else is kept", () => {
    const msg = "Умею ремонтировать технику. Не работаю после 22:00. Поднимаю до 20 кг.";
    const caps = [cap(REPAIR, "repair", { evidence: msg }), lifted("time_global", null, 6, msg, 22)];
    expect(run(caps, [cap(REPAIR, "repair")], review("numeric", "Не работаю после 22:00.")).matchType).toBe("exact");
    expect(run(caps, [cap(REPAIR, "repair")], review("numeric", "Поднимаю до 20 кг.")).reason).toBe("numeric_mismatch");
  });
  it("a lifted restriction of OTHER work does not hide a conflict about this order", () => {
    const r = run([cap(REPAIR, "repair"), lifted("work", "delivery", DELIVERY, MSG1)], [cap(REPAIR, "repair")], review("exclusion", "Не занимаюсь доставкой."));
    expect(r.reason).toBe("exclusion_mismatch");
  });
  it("history markers are never a time window, a refusal or a skill for matching", () => {
    const r = run([cap(REPAIR, "repair"), lifted("time_global", null, 6, "Не работаю после 22:00.", 22), lifted("work", "repair", REPAIR, "Не чиню технику.")], [cap(REPAIR, "repair"), { kind: "availability", phrase: "после 23", nodeIds: [], confidence: 1, mandatory: false, constraintType: "availability", startHour: 23 }]);
    expect(r.matchType).toBe("exact");
  });
});

describe("the user's own lift statement (recorded even when the old limit was never a separate fact)", () => {
  const liftMarker = (area: string, node: string | null, i: number, evidence: string): Fact => ({ ...lifted(area, node, i, evidence), resourceCapacity: { value: null, unit: null, kind: `lifted:${area}` } });
  it("«Теперь делаю и Android»: a scope conflict quoting «только iOS» from the old message is ignored", () => {
    const caps = [cap(MOBILE, "programming"), liftMarker("lift_work_scope", "programming", MOBILE, "Теперь делаю и Android.")];
    expect(run(caps, [cap(MOBILE, "programming")], review("scope", "делаю только iOS-приложения")).matchType).toBe("exact");
    // unrelated work: kept
    expect(run(caps, [cap(REPAIR, "repair")], review("scope", "только ремонт")).reason).toBe("scope_mismatch");
  });
  it("«Теперь работаю после 22:00»: a time conflict is ignored, a non-time numeric conflict is not", () => {
    const caps = [cap(REPAIR, "repair"), liftMarker("lift_time_global", null, 6, "Теперь работаю после 22:00.")];
    expect(run(caps, [cap(REPAIR, "repair")], review("numeric", "Не работаю после 22:00.")).matchType).toBe("exact");
    expect(run(caps, [cap(REPAIR, "repair")], review("numeric", "Поднимаю до 20 кг.")).reason).toBe("numeric_mismatch");
  });
  it("a live restriction of the same area keeps the conflict", () => {
    const liveScope: Fact = { ...cap(MOBILE, "programming"), constraintType: "scope", phrase: "только мобильная разработка" };
    const caps = [cap(MOBILE, "programming"), liveScope, liftMarker("lift_work_scope", "programming", MOBILE, "Теперь делаю и Android.")];
    expect(run(caps, [cap(MOBILE, "programming")], review("scope", "только мобильная разработка")).reason).toBe("scope_mismatch");
  });
});

it("a lift without an ontology node still applies when it names what the order asks for", () => {
  const liftNoNode: Fact = { ...lifted("lift_work_scope", null, 6, "Теперь делаю и Android."), resourceCapacity: { value: null, unit: null, kind: "lifted:lift_work_scope" } };
  const req: Fact = { kind: "capability", phrase: "разработка", nodeIds: [], confidence: 1, mandatory: false, embedding: v(5) };
  const scopeConflict = { compatible: false, confidence: 0.95, reason: "only iOS", hardConflict: { kind: "scope", profileEvidence: "делаю только iOS-приложения", orderEvidence: "Нужно разработать Android-приложение для магазина" } };
  const ios = { ...cap(MOBILE, "programming"), nodeIds: [] };
  expect(evaluateSemantic({ capabilities: [ios, liftNoNode], requirements: [req], relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false, semanticReview: scopeConflict }).reason).not.toBe("scope_mismatch");
  const other = { ...scopeConflict, hardConflict: { ...scopeConflict.hardConflict, orderEvidence: "Нужен репетитор по математике" } };
  expect(evaluateSemantic({ capabilities: [ios, liftNoNode], requirements: [req], relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false, semanticReview: other }).reason).toBe("scope_mismatch");
});
