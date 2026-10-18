/**
 * Дефекты №4/№5 (QA 2026-10-14): спецификация Codex (docs/evaluations/qa-2026-10-14/incremental-4-5-spec)
 * подключена к НАСТОЯЩЕМУ incremental processor (prepareDocument с prior state), без toy reducer:
 *  - ответ AI каждого шага — fixture (facts + логические remove-targets), targets разрешаются в реальные
 *    item_N через profileItemsOf(prior.facts); пустое разрешение — нарушение, а не молчаливый no-op;
 *  - наблюдение — из фактов результата processor (active / revoked / missing / superseded-история),
 *    подписи времени — существующий reader pickRestrictions (API), без Set/dedup;
 *  - проверка заказа digging на 23:00 — настоящий evaluateSemantic (matching не изменяется).
 * Два режима: полный последовательный transcript и изолированный шаг на проверенном корректном префиксе.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { mockProviders } from "@ustal/ai";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { evaluateSemantic } from "@ustal/matching";
import { prepareDocument, profileItemsOf, type PreparedFact, type PriorProfileState } from "../src/semantic.js";
import { isRevokedCapability } from "../src/profile-negatives.js";
import { pickRestrictions } from "../../api/src/lib/profile-diff.js";
import { fact, scenarios, type ExpectedState, type FactFixture, type RemoveTarget, type Scenario, type StepFixture } from "../../../docs/evaluations/qa-2026-10-14/incremental-4-5-spec/fixtures.js";
import { stateViolations, type ObservedState } from "../../../docs/evaluations/qa-2026-10-14/incremental-4-5-spec/helpers.js";

assertLocalTestDatabase();
afterAll(async () => { await getSql().end(); });
const OUT = process.env.INC45_OUT ?? "";
const KEYS = ["appliance_repair", "digging", "assembly", "van", "refrigerator_repair", "delivery"];
const UNKNOWN: Record<string, string> = { "самолет": "plane", "вайбкодинг": "vibecoding", "квадрокоптер": "quadcopter" };
let keyOfNode = new Map<string, string>();
let nodeOfKey = new Map<string, string>();
beforeAll(async () => {
  const rows = await getDb().select({ id: schema.ontologyNodes.id, key: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes)
    .where(inArray(schema.ontologyNodes.canonicalKey, KEYS));
  keyOfNode = new Map(rows.map((r) => [r.id, r.key]));
  nodeOfKey = new Map(rows.map((r) => [r.key, r.id]));
  expect(nodeOfKey.size).toBe(KEYS.length); // seed содержит все узлы спецификации
});

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[.!?,]+$/g, "").trim();
const keyOf = (f: PreparedFact) => {
  const known = f.nodeIds.map((id) => keyOfNode.get(id)).filter((k): k is string => !!k);
  if (known.length) return known.join("+");
  return UNKNOWN[norm(f.phrase)] ?? `?${f.phrase}`;
};
const active = (facts: PreparedFact[]) => facts.filter((f) => (f.kind as string) !== "superseded");

/** Наблюдение состояния из фактов результата processor; ничего не нормализуется под expected. */
async function observe(facts: PreparedFact[]): Promise<ObservedState> {
  const a = active(facts);
  const isRefusal = (f: PreparedFact) => f.kind === "exclude" || f.constraintType === "exclusion";
  const state: ObservedState = {
    skills: a.filter((f) => f.kind === "capability" && !isRefusal(f) && f.constraintType !== "scope").map(keyOf),
    resources: a.filter((f) => f.kind === "resource" && f.resourceRole !== "missing").map(keyOf),
    missingResources: a.filter((f) => f.kind === "resource" && f.resourceRole === "missing").map(keyOf),
    revokedSkills: a.filter((f) => isRefusal(f) && isRevokedCapability(f)).map(keyOf),
    workRestrictions: a.filter((f) => isRefusal(f) && !isRevokedCapability(f)).map(keyOf),
    timeRestrictions: a.filter((f) => f.kind === "availability" || (f.kind === "capability" && (f.startHour != null || f.endHour != null)))
      .map((f) => ({ scope: f.constraintScope === "fact" || f.kind !== "availability" ? "activity" as const : "global" as const,
        endHour: f.endHour ?? null, label: pickRestrictions([f])[0]?.text ?? "" })),
  };
  if (state.skills.includes("digging")) state.order23 = await order23(facts);
  return state;
}

/** Настоящий matching: заказ digging (mandatory) + отдельный факт времени 23:00. */
async function order23(profile: PreparedFact[]) {
  const base = { subjectType: "unspecified", confidence: 0.95, constraintScope: "whole_task", resourceRole: "none",
    resourceCapacity: { value: null, unit: null, kind: null }, daysOfWeek: null, refusalIntent: null, startHour: null, endHour: null };
  const text = "Нужно выкопать яму в 23:00";
  const req = await withNormalization({ facts: [
    { ...base, kind: "capability", phrase: "выкопать яму", evidence: text, canonicalKeys: ["digging"], mandatory: true, constraintType: "none" },
    { ...base, kind: "availability", phrase: "в 23:00", evidence: text, canonicalKeys: [], mandatory: true, constraintType: "availability", startHour: 23 },
  ] }, () => prepareDocument("order", text, {}, randomUUID()));
  const r = evaluateSemantic({ capabilities: profile, requirements: req.facts, relations: [], documentSimilarity: 0.9, riskLevel: 0, regulated: false });
  return { rejected: r.classification === "reject", reason: String(r.reason ?? r.classification) };
}

async function withNormalization<T>(data: unknown, run: () => Promise<T>, seen?: (input: unknown) => void): Promise<T> {
  const spy = vi.spyOn(mockProviders.extraction, "normalizeMatching").mockImplementation(async (input) => {
    seen?.(input);
    return { data, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0 } as never;
  });
  try { return await run(); } finally { spy.mockRestore(); }
}

/** Логическая цель remove → реальные item_N текущего профиля. */
function resolveTargets(targets: RemoveTarget[], prior: PriorProfileState | undefined, problems: string[]) {
  if (!targets.length) return [];
  const { items, byId } = profileItemsOf(prior?.facts ?? []);
  const ids: string[] = [];
  for (const t of targets) {
    const hit = items.filter((i) => t.kind === "all" || (i.type === t.kind && (!t.key || keyOf(byId.get(i.id)!).split("+").includes(t.key))));
    if (!hit.length) problems.push(`remove target ${JSON.stringify(t)} has no item in CURRENT_PROFILE`);
    ids.push(...hit.map((i) => i.id));
  }
  return ids;
}

interface StepLog { step: string; message: string; operation: string; aiFacts: unknown; removeTargets: RemoveTarget[]; resolvedRemoves: string[];
  currentProfile: unknown; expected: unknown; actual: ObservedState; activeFacts: unknown[]; violations: string[] }

async function applyStep(step: StepFixture, prior: PriorProfileState | undefined) {
  const problems: string[] = [];
  const removes = resolveTargets(step.ai.removes, prior, problems);
  let currentProfile: unknown = null;
  const doc = await withNormalization({ facts: step.ai.facts, ...(prior ? { removes } : {}) },
    () => prepareDocument("profile", step.message, {}, randomUUID(), prior),
    (input) => { currentProfile = (input as { profileItems?: unknown }).profileItems ?? null; });
  const next: PriorProfileState = { sourceText: doc.sourceText, facts: doc.facts };
  const actual = await observe(doc.facts);
  return { next, log: { step: step.id, message: step.message, operation: step.operation, aiFacts: step.ai.facts.map((f) => `${f.kind}:${f.canonicalKeys.join(",") || f.phrase}${f.endHour != null ? "@" + f.endHour : ""}`),
    removeTargets: step.ai.removes, resolvedRemoves: removes, currentProfile, expected: step.expected, actual,
    activeFacts: active(doc.facts).map((f) => ({ kind: f.kind, key: keyOf(f), role: f.resourceRole, endHour: f.endHour, scope: f.constraintScope, cap: f.resourceCapacity?.kind ?? null, evidence: f.evidence })),
    violations: [...problems, ...stateViolations(actual, step.expected)] } as StepLog };
}

async function sequential(scenario: Scenario) {
  let prior: PriorProfileState | undefined;
  const transcript: StepLog[] = [];
  for (const step of scenario.steps) {
    const r = await applyStep(step, prior);
    transcript.push(r.log);
    prior = r.next;
  }
  return transcript;
}

/** Шаг k на префиксе 1..k-1, только если префикс проверен (иначе — каскад, шаг не оценивается). */
async function isolated(scenario: Scenario) {
  const out: { step: string; status: "pass" | "fail" | "prefix_invalid"; violations: string[] }[] = [];
  for (let k = 1; k < scenario.steps.length; k++) {
    let prior: PriorProfileState | undefined;
    let valid = true;
    for (const step of scenario.steps.slice(0, k)) {
      const r = await applyStep(step, prior);
      prior = r.next;
      valid = r.log.violations.length === 0;
    }
    if (!valid) { out.push({ step: scenario.steps[k]!.id, status: "prefix_invalid", violations: [] }); continue; }
    const r = await applyStep(scenario.steps[k]!, prior);
    out.push({ step: r.log.step, status: r.log.violations.length ? "fail" : "pass", violations: r.log.violations });
  }
  return out;
}

const report: Record<string, unknown> = {};
afterAll(() => { if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2)); });

describe("incremental 4/5 spec: 9 scenarios / 37 expected states (sequential)", () => {
  it("probe sanity: real matching rejects digging at 23:00 only under a global window", async () => {
    const plain = await sequential({ id: "probe", defect: 4, title: "", steps: [scenarios[5]!.steps[0]!] });
    expect(plain[0]!.actual.order23).toEqual({ rejected: true, reason: "outside_availability" });
  });
  for (const scenario of scenarios)
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const transcript = await sequential(scenario);
      report[scenario.id] = { sequential: transcript };
      const failed = transcript.filter((s) => s.violations.length).map((s) => `${s.step} «${s.message}»: ${s.violations.join("; ")}`);
      expect(failed, failed.join("\n")).toEqual([]);
    });
});

describe("incremental 4/5 spec: isolated step on a verified prefix", () => {
  for (const scenario of scenarios)
    it(`${scenario.id}`, async () => {
      const res = await isolated(scenario);
      (report[scenario.id] as Record<string, unknown> ?? (report[scenario.id] = {}) as Record<string, unknown>).isolated = res;
      const failed = res.filter((r) => r.status !== "pass").map((r) => `${r.step}: ${r.status} ${r.violations.join("; ")}`);
      expect(failed, failed.join("\n")).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------------------
// Дополнительные длинные последовательности (сверх спецификации): неизвестный навык и ресурс, несколько
// обновлений времени, частичный отказ, навыки + ресурсы + ограничения одновременно; везде — злонамеренные
// removes и echo. Expected задан явно для каждого шага.
const unk = (phrase: string, over: Partial<FactFixture> = {}) => fact(phrase, { phrase, canonicalKeys: [], ...over });
const sk = (k: string) => fact(k), res = (k: string, missing = false) => fact(k, { kind: "resource", subjectType: "physical_resource", resourceRole: missing ? "missing" : "available" });
const rev = (k: string) => fact(k, { kind: "exclude", constraintType: "exclusion", refusalIntent: "revoke" });
const rst = (k: string) => fact(k, { kind: "exclude", constraintType: "exclusion", refusalIntent: "restriction" });
const tm = (h: number) => fact("", { kind: "availability", phrase: `работаю до ${h}:00`, canonicalKeys: [], constraintType: "availability", endHour: h });
const T = (kind: RemoveTarget["kind"], key?: string): RemoveTarget => ({ kind, ...(key ? { key } : {}) });
const st = (skills: string[], resources: string[] = [], workRestrictions: string[] = [], globalEndHours: number[] = [], revokedSkills: string[] = [], missingResources: string[] = []): ExpectedState => ({
  skills, resources, workRestrictions, globalEndHours, revokedSkills, missingResources,
  order23: !skills.includes("digging") ? "not_applicable" : globalEndHours.length ? "blocked" : "allowed" });
const S = (id: string, message: string, facts: FactFixture[], removes: RemoveTarget[], expected: ExpectedState): StepFixture =>
  ({ id, message, operation: "", ai: { facts: facts.map((f) => ({ ...f, evidence: message })), removes }, expected, invariants: [] });
const extra: Scenario[] = [
  { id: "X-UNKNOWN", defect: "4+5", title: "unknown capability and resource: add, noise, revoke, echo, restore, missing", steps: [
    S("01", "Занимаюсь вайбкодингом", [unk("вайбкодинг")], [], st(["vibecoding"])),
    S("02", "Есть квадрокоптер", [unk("квадрокоптер", { kind: "resource", subjectType: "physical_resource", resourceRole: "available" })], [], st(["vibecoding"], ["quadcopter"])),
    S("03", "👍", [], [T("all")], st(["vibecoding"], ["quadcopter"])),
    S("04", "Вайбкодингом больше не занимаюсь", [unk("вайбкодинг", { kind: "exclude", constraintType: "exclusion", refusalIntent: "revoke" })], [T("skill", "vibecoding")], st([], ["quadcopter"], [], [], ["vibecoding"])),
    S("05", "Ещё умею собирать мебель", [sk("assembly"), unk("вайбкодинг")], [T("all")], st(["assembly"], ["quadcopter"], [], [], ["vibecoding"])),
    S("06", "Снова занимаюсь вайбкодингом", [unk("вайбкодинг")], [T("removed_skill", "vibecoding")], st(["assembly", "vibecoding"], ["quadcopter"])),
    S("07", "Квадрокоптер разбил, его больше нет", [unk("квадрокоптер", { kind: "resource", subjectType: "physical_resource", resourceRole: "missing" })], [T("resource", "quadcopter")], st(["assembly", "vibecoding"], [], [], [], [], ["quadcopter"])),
    S("08", "Спасибо!", [unk("квадрокоптер", { kind: "resource", subjectType: "physical_resource", resourceRole: "available" })], [T("all")], st(["assembly", "vibecoding"], [], [], [], [], ["quadcopter"])),
  ] },
  { id: "X-TIME-MULTI", defect: 5, title: "several consecutive time updates with stale echoes", steps: [
    S("01", "Могу копать. Работаю до 22:00", [sk("digging"), tm(22)], [], st(["digging"], [], [], [22])),
    S("02", "Теперь до 21:00", [tm(21), tm(22)], [T("time_limit")], st(["digging"], [], [], [21])),
    S("03", "Теперь работаю до 20:00", [tm(20), tm(21)], [T("time_limit")], st(["digging"], [], [], [20])),
    S("04", "Работаю до 9 вечера", [tm(21)], [T("time_limit")], st(["digging"], [], [], [21])),
    S("05", "Есть газель", [res("van"), tm(20)], [T("time_limit")], st(["digging"], ["van"], [], [21])),
    S("06", "Ограничений по времени больше нет", [tm(21)], [T("time_limit")], st(["digging"], ["van"])),
    S("07", "Хорошо", [tm(21)], [], st(["digging"], ["van"])),
    S("08", "Работаю до 19:00", [tm(19)], [], st(["digging"], ["van"], [], [19])),
  ] },
  { id: "X-MIXED", defect: "4+5", title: "skills + resources + restrictions: add → update → partial revoke → unrelated → restore", steps: [
    S("01", "Ремонтирую бытовую технику, есть газель, доставкой не занимаюсь", [sk("appliance_repair"), res("van"), rst("delivery")], [], st(["appliance_repair"], ["van"], ["delivery"])),
    S("02", "Теперь могу и копать", [sk("digging")], [T("all")], st(["appliance_repair", "digging"], ["van"], ["delivery"])),
    S("03", "Холодильники не ремонтирую", [rst("refrigerator_repair")], [T("skill", "appliance_repair")], st(["appliance_repair", "digging"], ["van"], ["delivery", "refrigerator_repair"])),
    S("04", "Доставкой снова занимаюсь", [sk("delivery")], [T("refusal", "delivery")], st(["appliance_repair", "digging", "delivery"], ["van"], ["refrigerator_repair"])),
    S("05", "Больше не копаю", [rev("digging")], [T("skill", "digging")], st(["appliance_repair", "delivery"], ["van"], ["refrigerator_repair"], [], ["digging"])),
    S("06", "Привет", [sk("digging"), res("van", true)], [T("all")], st(["appliance_repair", "delivery"], ["van"], ["refrigerator_repair"], [], ["digging"])),
    S("07", "Ещё умею собирать мебель", [sk("assembly"), sk("digging")], [T("resource", "van")], st(["appliance_repair", "delivery", "assembly"], ["van"], ["refrigerator_repair"], [], ["digging"])),
    S("08", "Снова копаю", [sk("digging")], [T("removed_skill", "digging")], st(["appliance_repair", "delivery", "assembly", "digging"], ["van"], ["refrigerator_repair"])),
    S("09", "Работаю до 21:00", [tm(21)], [], st(["appliance_repair", "delivery", "assembly", "digging"], ["van"], ["refrigerator_repair"], [21])),
  ] },
];
describe("incremental 4/5: extra long sequences", () => {
  for (const scenario of extra)
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const transcript = await sequential(scenario);
      report[scenario.id] = { sequential: transcript };
      const failed = transcript.filter((t) => t.violations.length).map((t) => `${t.step} «${t.message}»: ${t.violations.join("; ")}`);
      expect(failed, failed.join("\n")).toEqual([]);
    });
});
