import { expect, it } from "vitest";
import type { SemanticReview } from "@ustal/validation";
import { applyReviewConstraints } from "./review-constraints.js";
import { EvidenceValidationError } from "./evidence-validation.js";

const positive: SemanticReview = { compatible: true, confidence: .8, reason: "Related capability", hardConflict: null };
const apply = (profile: string, order: string, extra: Partial<SemanticReview>) =>
  applyReviewConstraints({ ...positive, ...extra }, { profile: [profile], order: [order] });

it.each([
  ["водитель, категория B", "перевозка пассажиров"],
  ["водитель, категория B", "категория D требуется"],
  ["только категория B", "перевозка пассажиров"],
])("does not infer missing eligibility from %s / %s", (profile, order) => {
  expect(apply(profile, order, { hardConflict: { kind: "eligibility", profileEvidence: profile, orderEvidence: order } }))
    .toMatchObject({ compatible: true, hardConflict: null });
});
it.each(["только категория B", "категории D нет", "I do not have category D"])("preserves explicit absence: %s", profile => {
  const order = "категория D требуется";
  expect(apply(profile, order, { hardConflict: { kind: "eligibility", profileEvidence: profile, orderEvidence: order } }))
    .toMatchObject({ compatible: false, hardConflict: { kind: "eligibility" } });
});
it("a negative verdict justified only by a suppressed credential conflict is normalized to relevant", () => {
  expect(apply("category B", "category D", { compatible: false, hardConflict: { kind: "eligibility", profileEvidence: "category B", orderEvidence: "category D" } }))
    .toMatchObject({ compatible: true, hardConflict: null });
});
it("BH-038 pattern: compatible=false without a grounded hardConflict requires repair, not a final reject", () => {
  const profile = '{"skill":"водитель","license":"категория B"}', order = '{"category":"перевозка пассажиров","license":"категория D требуется"}';
  expect(() => apply(profile, order, { compatible: false, confidence: 1, hardConflict: null, numericLimits: [], exclusiveScope: null }))
    .toThrow(EvidenceValidationError);
});
it("an unrelated domain stays negative with a grounded domain conflict", () => {
  expect(apply("преподаватель математики", "урок химии", { compatible: false, hardConflict: { kind: "domain", profileEvidence: "преподаватель математики", orderEvidence: "урок химии" } }))
    .toMatchObject({ compatible: false, hardConflict: { kind: "domain" } });
});
it("preserves other objective eligibility conflicts", () => {
  expect(apply("age 18", "age 21 required", { hardConflict: { kind: "eligibility", profileEvidence: "age 18", orderEvidence: "age 21 required" } }))
    .toMatchObject({ compatible: false, hardConflict: { kind: "eligibility" } });
});

it.each([
  ["печать 60 слов/мин", "требуется 120 слов/мин", 60, 120, "слов/мин"],
  ["могу поднять максимум 15кг", "поднять 50кг", 15, 50, "кг"],
  ["maximum 2.5 kg", "required 3 kg", 2.5, 3, "kg"],
] as const)("rejects the grounded per-item numeric limit: %s", (profile, order, available, required, unit) => {
  expect(apply(profile, order, { numericLimits: [{ profileEvidence: profile, orderEvidence: order, metric: "capacity", available, required, availableUnit: unit, requiredUnit: unit, limitKind: "per_item", wholeTaskEvidence: null }] }))
    .toMatchObject({ compatible: false, hardConflict: { kind: "numeric" } });
});
it.each([
  { available: null, required: 50, availableUnit: null, requiredUnit: "кг", limitKind: "per_item", wholeTaskEvidence: null },
  { available: 15, required: null, availableUnit: "кг", requiredUnit: null, limitKind: "per_item", wholeTaskEvidence: null },
  { available: 15, required: 50, availableUnit: "кг", requiredUnit: "g", limitKind: "per_item", wholeTaskEvidence: null },
  { available: 15, required: 50, availableUnit: "кг", requiredUnit: "кг", limitKind: "total_quantity", wholeTaskEvidence: null },
  { available: 50, required: 15, availableUnit: "кг", requiredUnit: "кг", limitKind: "per_item", wholeTaskEvidence: null },
] as const)("does not invent a comparable whole-task incompatibility: %j", limit => {
  expect(apply("15кг 50кг", "15кг 50кг 50g", { numericLimits: [{ profileEvidence: "15кг 50кг", orderEvidence: "15кг 50кг 50g", metric: "capacity", ...limit }] }).compatible).toBe(true);
});
it.each([["2D only", "3D animation", "2D", "3D"], ["только Android", "iOS app", "Android", "iOS"]])("exclusive boundary beats positive relevance: %s", (profile, order, allowed, requested) => {
  expect(apply(profile, order, { exclusiveScope: { profileEvidence: profile, orderEvidence: order, allowed: [allowed], requested, requestedWithinAllowed: false } }))
    .toMatchObject({ compatible: false, hardConflict: { kind: "scope" } });
});
it("does not turn experience into an exclusive boundary", () => {
  expect(apply("2D experience", "3D animation", { exclusiveScope: { profileEvidence: "2D experience", orderEvidence: "3D animation", allowed: ["2D"], requested: "3D", requestedWithinAllowed: false } }).compatible).toBe(true);
});
it("missing details alone do not reject", () => {
  expect(apply("driver", "transport", { numericLimits: [], exclusiveScope: null })).toMatchObject({ compatible: true, hardConflict: null });
});
it("does not accept fabricated numeric evidence", () => {
  expect(() => apply("15кг", "50кг", { numericLimits: [{ profileEvidence: "15кг", orderEvidence: "50кг", metric: "lifting", available: 10, required: 50, availableUnit: "кг", requiredUnit: "кг", limitKind: "per_item", wholeTaskEvidence: null }] })).toThrow("Numeric limit");
});

// Regression patterns from blind holdout run b6251585 (general rules, no case IDs in code).
const limit = (profileEvidence: string, orderEvidence: string, available: number, required: number, availableUnit: string, requiredUnit: string,
  limitKind: "rate" | "threshold" | "per_item" | "total_quantity", wholeTaskEvidence: string | null = null) =>
  ({ profileEvidence, orderEvidence, metric: "m", available, required, availableUnit, requiredUnit, limitKind, wholeTaskEvidence });
it("BH-004 pattern: a rate unit is a hard limit even if labelled total_quantity", () => {
  const p = '{"skill":"печать документов","speed":"60 слов/мин"}', o = '{"category":"стенография совещания","speed_req":"120 слов/мин"}';
  expect(apply(p, o, { numericLimits: [limit(p, o, 60, 120, "слов/мин", "слов/мин", "total_quantity")] })).toMatchObject({ compatible: false, hardConflict: { kind: "numeric" } });
});
it("BH-028 pattern: 15 кг vs 50 кг per item rejects", () => {
  const p = '{"skill":"курьер","can_lift":"15кг"}', o = '{"category":"доставка мебели","weight":"50кг"}';
  expect(apply(p, o, { numericLimits: [limit(p, o, 15, 50, "кг", "kg", "per_item")] })).toMatchObject({ compatible: false, hardConflict: { kind: "numeric" } });
});
it("BH-046 pattern: 10 м vs 40 m threshold rejects via closed unit equivalence", () => {
  const p = '{"skill":"кровельщик","height":"до 10м"}', o = '{"category":"кровельные работы","height":"40m"}';
  expect(apply(p, o, { numericLimits: [limit(p, o, 10, 40, "м", "m", "threshold")] })).toMatchObject({ compatible: false, hardConflict: { kind: "numeric" } });
});
it("does not equate different magnitudes (м vs км)", () => {
  expect(apply("до 10 м", "40 км", { numericLimits: [limit("до 10 м", "40 км", 10, 40, "м", "км", "threshold")] }).compatible).toBe(true);
});
it("BH-034 pattern: a divisible total quantity without explicit one-trip wording matches", () => {
  const p = '{"skill":"фургон","объём":"3 куб.м"}', o = '{"category":"вывоз строительного мусора","объём":"10 куб.м"}';
  expect(apply(p, o, { numericLimits: [limit(p, o, 3, 10, "куб.м", "куб.м", "total_quantity")] })).toMatchObject({ compatible: true, hardConflict: null });
});
it("a total quantity rejects only with grounded explicit one-trip wording", () => {
  const p = '{"skill":"фургон","объём":"3 куб.м"}', o = '{"объём":"10 куб.м","условие":"за один рейс"}';
  expect(apply(p, o, { numericLimits: [limit(p, o, 3, 10, "куб.м", "куб.м", "total_quantity", "за один рейс")] })).toMatchObject({ compatible: false, hardConflict: { kind: "numeric" } });
  expect(() => apply(p, o, { numericLimits: [limit(p, o, 3, 10, "куб.м", "куб.м", "total_quantity", "одним рейсом")] })).toThrow(EvidenceValidationError);
});
it("BH-082 pattern: 2D only vs 3D rejects when the reviewer states it is outside the scope", () => {
  const p = '{"skill":"аниматор","experience":"2D only"}', o = '{"category":"3D анимация","format":"3D"}';
  expect(apply(p, o, { exclusiveScope: { profileEvidence: p, orderEvidence: o, allowed: ["2D"], requested: "3D", requestedWithinAllowed: false } }))
    .toMatchObject({ compatible: false, hardConflict: { kind: "scope" } });
});
it("BH-082 pattern: an omitted exclusive-scope inventory requires repair", () => {
  const p = '{"skill":"аниматор","experience":"2D only"}', o = '{"category":"3D анимация","format":"3D"}';
  expect(() => apply(p, o, { exclusiveScope: null })).toThrow(EvidenceValidationError);
});
it("BH-003 pattern: only-remote with a remote request (other language) matches", () => {
  const p = '{"skill":"бухгалтерия","constraints":"только удалённо"}', o = '{"category":"выписка счётов","format":"remote"}';
  expect(apply(p, o, { exclusiveScope: { profileEvidence: p, orderEvidence: o, allowed: ["удалённо"], requested: "remote", requestedWithinAllowed: true } }))
    .toMatchObject({ compatible: true, hardConflict: null });
});
it("an order that does not state the scoped dimension has no scope conflict", () => {
  const p = '{"skill":"бухгалтерия","constraints":"только удалённо"}', o = '{"category":"выписка счётов"}';
  expect(apply(p, o, { exclusiveScope: { profileEvidence: p, orderEvidence: o, allowed: ["удалённо"], requested: null, requestedWithinAllowed: false } }))
    .toMatchObject({ compatible: true, hardConflict: null });
});
it("2D experience without only needs no exclusive-scope inventory", () => {
  expect(apply('{"experience":"2D experience"}', '{"format":"3D"}', { exclusiveScope: null })).toMatchObject({ compatible: true, hardConflict: null });
});
it("'не только' is not an exclusive boundary", () => {
  expect(apply('{"languages":"не только русский"}', '{"language":"английский"}', { exclusiveScope: null }).compatible).toBe(true);
});
it("BH-066 pattern: a translated JSON field name is rejected, the literal value quote is accepted", () => {
  const p = '{"skill":"уборщица","allergies":"не работаю с бытовой химией"}', o = '{"category":"уборка с химией","required":"бытовая химия"}';
  const conflict = (orderEvidence: string) => ({ hardConflict: { kind: "exclusion" as const, profileEvidence: "не работаю с бытовой химией", orderEvidence }, compatible: false });
  expect(() => apply(p, o, conflict("требуется бытовая химия"))).toThrow(EvidenceValidationError);
  expect(apply(p, o, conflict("бытовая химия"))).toMatchObject({ compatible: false, hardConflict: { kind: "exclusion" } });
});
