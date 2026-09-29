import { describe, expect, it } from "vitest";
import { isEvaluativeTrait, mentionsSensitiveCategory, type ExtractedProfileFact, type ProfileFactValue } from "@ustal/validation";
import { labelSupported, locateEvidence, numbersSupported, planSlotResolution, slotKeyFor, validateExtractedFacts } from "./profile-facts.js";

const v = (p: Partial<ProfileFactValue> = {}): ProfileFactValue =>
  ({ label: null, number: null, numberMax: null, unit: null, period: null, level: null, flag: null, timeframe: null, approximate: false, ...p });
const fact = (factType: ExtractedProfileFact["factType"], evidence: string, value: Partial<ProfileFactValue>, extra: Partial<ExtractedProfileFact> = {}): ExtractedProfileFact =>
  ({ factType, evidence, value: v(value), assertion: "explicit", confidence: 0.9, sensitive: false, ...extra });

describe("one input -> many typed facts (Phase 1 profile_facts)", () => {
  const src = "Работал директором завода 7 лет, около 300 сотрудников, вывел предприятие из убытков, переезжать не хочу, но командировки нормально.";
  it("keeps role, duration, management scope, achievement, relocation and travel as separate facts", () => {
    const { accepted, rejected } = validateExtractedFacts(src, [
      fact("role", "Работал директором завода", { label: "директор завода", timeframe: "past" }),
      fact("experience", "директором завода 7 лет", { label: "директор завода", number: 7, unit: "год" }),
      fact("management", "около 300 сотрудников", { label: "сотрудники", number: 300, unit: "человек", approximate: true }),
      fact("achievement", "вывел предприятие из убытков", { label: "вывел предприятие из убытков" }),
      fact("relocation", "переезжать не хочу", { flag: false }),
      fact("travel", "командировки нормально", { flag: true }),
    ]);
    expect(rejected).toEqual({});
    expect(accepted.map((f) => f.factType)).toEqual(["role", "experience", "management", "achievement", "relocation", "travel"]);
    for (const f of accepted) expect(src).toContain(f.evidence);
    expect(accepted.find((f) => f.factType === "relocation")!.slotKey).toBe("relocation");
  });
});

describe("evidence safety: no invented facts", () => {
  const src = "Последние четыре года был коммерческим директором, управлял отделом около 60 человек.";
  const result = validateExtractedFacts(src, [
    fact("role", "был коммерческим директором", { label: "коммерческий директор", timeframe: "past" }),
    fact("experience", "Последние четыре года", { label: "коммерческий директор", number: 4, unit: "год" }),
    fact("management", "управлял отделом около 60 человек", { label: "отдел", number: 60, unit: "человек", approximate: true }),
    fact("industry", "был коммерческим директором", { label: "ритейл" }, { assertion: "inferred" }),
    fact("other", "коммерческим директором", { label: "выручка", number: 1_000_000_000 }),
    fact("education", "был коммерческим директором", { label: "MBA" }, { assertion: "inferred" }),
    fact("management", "управлял отделом около 60 человек", { label: "отдел продаж", number: 600 }),
    fact("language", "свободно говорю по-английски", { label: "английский" }),
  ]);
  it("allows role, ~4 years and ~60 people", () => {
    expect(result.accepted.map((f) => f.factType)).toEqual(["role", "experience", "management"]);
  });
  it("rejects industry=retail, revenue=1B, MBA (not supported by their evidence) and evidence absent from the input", () => {
    expect(result.rejected).toMatchObject({ label_not_supported: 3, evidence_not_in_source: 1, number_not_supported: 1 });
  });
  it("stored evidence is the original substring even when the model changes case/whitespace", () => {
    expect(locateEvidence("Есть  Газель,  права B/C", "есть газель, права b/c")).toBe("Есть  Газель,  права B/C");
    expect(locateEvidence("Есть Газель", "Есть Камаз")).toBeNull();
    expect(locateEvidence("abc", "«")).toBeNull();
  });
  it("numbers: digits must match, тыс./млн scale, word numerals allowed", () => {
    expect(numbersSupported(v({ number: 500000 }), "меньше 500 тыс. не рассматриваю")).toBe(true);
    expect(numbersSupported(v({ number: 5000000 }), "меньше 500 тыс. не рассматриваю")).toBe(false);
    expect(numbersSupported(v({ number: 4 }), "последние четыре года")).toBe(true);
    expect(numbersSupported(v({ number: 1500000 }), "от 1,5 млн")).toBe(true);
  });
  it("labels must share a stem with their own evidence", () => {
    expect(labelSupported("английский", "английский B2")).toBe(true);
    expect(labelSupported("ритейл", "коммерческим директором")).toBe(false);
  });
});

describe("server-side filters", () => {
  const src = "Готов работать удалённо. Есть диабет. Ищу работу активно.";
  it("drops sensitive facts, requires type values, validates job_search labels, dedupes slots", () => {
    const { accepted, rejected } = validateExtractedFacts(src, [
      fact("other", "Есть диабет", { label: "диабет" }, { sensitive: true }),
      fact("relocation", "Готов работать удалённо", { flag: null }),
      fact("job_search", "Ищу работу активно", { label: "very active" }),
      fact("job_search", "Ищу работу активно", { label: "active" }),
      fact("work_preference", "работать удалённо", { label: "удалённо" }),
      fact("work_preference", "Готов работать удалённо", { label: "Удалённо!" }),
    ]);
    expect(accepted.map((f) => f.slotKey)).toEqual(["job_search", "work_preference:удаленно"]);
    expect(rejected).toEqual({ sensitive: 1, missing_required_value: 1, invalid_job_search_label: 1, duplicate_slot: 1 });
  });
  it("slot keys: single-valued by type, multi-valued by normalized label", () => {
    expect(slotKeyFor("compensation", v({ number: 1 }))).toBe("compensation");
    expect(slotKeyFor("language", v({ label: " Английский  язык " }))).toBe("language:английский язык");
  });
});

describe("conflict/update model", () => {
  const t = (s: string) => new Date(s);
  it("the fact from the later message wins its slot; others are superseded by it", () => {
    const plan = planSlotResolution([
      { id: "a", slotKey: "compensation", userDecision: null, decidedAt: null, sourceCreatedAt: t("2026-01-01"), createdAt: t("2026-01-01") },
      { id: "b", slotKey: "compensation", userDecision: null, decidedAt: null, sourceCreatedAt: t("2026-06-01"), createdAt: t("2026-06-01") },
      { id: "c", slotKey: "language:английский", userDecision: null, decidedAt: null, sourceCreatedAt: t("2026-01-01"), createdAt: t("2026-01-01") },
    ]);
    expect(plan.get("a")).toEqual({ status: "superseded", supersededBy: "b" });
    expect(plan.get("b")).toEqual({ status: "active", supersededBy: null });
    expect(plan.get("c")).toEqual({ status: "active", supersededBy: null });
  });
  it("re-extracting an OLD message later never overrides a newer statement", () => {
    const plan = planSlotResolution([
      { id: "new-msg", slotKey: "compensation", userDecision: null, decidedAt: null, sourceCreatedAt: t("2026-06-01"), createdAt: t("2026-06-01") },
      { id: "old-msg-reextracted", slotKey: "compensation", userDecision: null, decidedAt: null, sourceCreatedAt: t("2026-01-01"), createdAt: t("2026-09-27") },
    ]);
    expect(plan.get("new-msg")!.status).toBe("active");
    expect(plan.get("old-msg-reextracted")!.status).toBe("superseded");
  });
});

describe("label grounding uses the evidence's own sentence", () => {
  it("accepts an experience label stated in the same sentence, still rejects one absent from it", () => {
    const src = "Работал директором завода 7 лет. Английский B1.";
    const r = validateExtractedFacts(src, [
      { factType: "experience", evidence: "7 лет", value: v({ label: "директор завода", number: 7, unit: "год" }), assertion: "explicit", confidence: 0.9, sensitive: false },
      { factType: "experience", evidence: "7 лет", value: v({ label: "английский", number: 7 }), assertion: "explicit", confidence: 0.9, sensitive: false },
    ]);
    expect(r.accepted.map((f) => f.slotKey)).toEqual(["experience:директор завода"]);
    expect(r.rejected).toEqual({ label_not_supported: 1 });
  });
});


// ---------------------------------------------------------------------------
// Phase 2A
// ---------------------------------------------------------------------------
describe("sensitive cause is dropped, the safe explicit restriction survives", () => {
  it("«У меня диабет, поэтому тяжести не поднимаю.» -> restriction «тяжести не поднимаю» only", () => {
    const src = "У меня диабет, поэтому тяжести не поднимаю.";
    const r = validateExtractedFacts(src, [
      fact("other", "У меня диабет", { label: "диабет" }, { sensitive: true }),
      fact("restriction", "тяжести не поднимаю", { label: "поднятие тяжестей" }),
      fact("restriction", "тяжести не поднимаю", { label: "тяжести из-за диабета" }), // unsafe label -> dropped
    ]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toMatchObject({ factType: "restriction", evidence: "тяжести не поднимаю" });
    expect(r.rejected).toEqual({ sensitive: 1, sensitive_evidence: 1 });
  });
  it("a quote that includes the cause is trimmed to its one safe clause (never stores the cause)", () => {
    const src = "У меня диабет, поэтому тяжести не поднимаю.";
    const r = validateExtractedFacts(src, [fact("restriction", "У меня диабет, поэтому тяжести не поднимаю", { label: "поднятие тяжестей" })]);
    expect(r.accepted.map((f) => f.evidence)).toEqual(["тяжести не поднимаю"]);
    // no safe clause that still states the fact (negation lost) -> dropped
    const r2 = validateExtractedFacts("Не работаю, так как беременна.", [fact("restriction", "Не работаю, так как беременна", { label: "работа" })]);
    expect(r2.accepted.map((f) => f.evidence)).toEqual(["Не работаю"]);
    const r3 = validateExtractedFacts("Беременна и не работаю ночью.", [fact("restriction", "Беременна и не работаю ночью", { label: "ночная работа" })]);
    expect(r3.accepted).toEqual([]);
  });
  it.each([
    ["Как православный, в воскресенье не работаю.", "в воскресенье не работаю", "как православный, в воскресенье не работаю"],
    ["Я беременна, поэтому ночью не работаю.", "ночью не работаю", "беременна, поэтому ночью не работаю"],
    ["После травмы спины не поднимаю больше 10 кг.", "не поднимаю больше 10 кг", "После травмы спины не поднимаю больше 10 кг"],
    ["Есть инвалидность, работаю только удалённо.", "работаю только удалённо", "Есть инвалидность, работаю только удалённо"],
  ])("%s -> safe fragment kept, sensitive quote dropped", (src, safe, unsafe) => {
    const r = validateExtractedFacts(src, [
      fact("restriction", safe, { label: safe.replace(/^(не |работаю )/, "") , number: /10/.test(safe) ? 10 : null }),
      fact("restriction", unsafe, { label: safe, number: /10/.test(safe) ? 10 : null }),
    ]);
    expect(r.accepted[0]!.evidence).toBe(safe);
    for (const f of r.accepted) expect(mentionsSensitiveCategory(`${f.evidence} ${f.value.label}`)).toBe(false);
    expect(r.accepted.length + (r.rejected.sensitive_evidence ?? 0) + (r.rejected.duplicate_slot ?? 0)).toBe(2);
  });
  it("detector: special categories yes, ordinary work words no", () => {
    for (const t of ["диабет 2 типа", "инвалид", "член партии", "мусульманин", "судимость", "ВИЧ", "профсоюз"]) expect(mentionsSensitiveCategory(t), t).toBe(true);
    for (const t of ["операционный директор", "партию товара принять", "частичная занятость", "лечу? нет, вожу", "раскройщик", "колонна техники"]) expect(mentionsSensitiveCategory(t), t).toBe(false);
  });
});

describe("explicit vs inferred", () => {
  it("evaluative qualities are never inferred from indirect signs", () => {
    const src = "Руководил отделом из 300 человек. Я очень стрессоустойчивый.";
    const r = validateExtractedFacts(src, [
      fact("other", "Руководил отделом из 300 человек", { label: "сильный лидер" }, { assertion: "inferred", confidence: 0.95 }),
      fact("other", "Руководил отделом", { label: "ответственный" }, { assertion: "inferred" }),
      fact("other", "Я очень стрессоустойчивый", { label: "стрессоустойчивый" }), // explicit self-description
      fact("management", "Руководил отделом из 300 человек", { label: "отдел", number: 300 }),
    ]);
    // "сильный лидер" has no stem in its sentence -> label check; "ответственный" -> inferred trait
    expect(r.accepted.map((f) => f.value.label)).toEqual(["стрессоустойчивый", "отдел"]);
    expect(r.rejected.inferred_trait! + (r.rejected.label_not_supported ?? 0)).toBe(2);
  });
  it("inferred trait is rejected even when the words are in the sentence", () => {
    const r = validateExtractedFacts("Я лидер команды и ответственный за закупки.", [
      fact("other", "Я лидер команды", { label: "лидер" }, { assertion: "inferred", confidence: 0.99 }),
      fact("responsibility", "ответственный за закупки", { label: "ответственный за закупки" }, { assertion: "inferred" }),
    ]);
    expect(r.rejected).toEqual({ inferred_trait: 1 });
    expect(r.accepted.map((f) => f.factType)).toEqual(["responsibility"]);
  });
  it("model confidence never lifts an inferred fact above the cap", () => {
    const r = validateExtractedFacts("Работу активно не ищу, но интересные предложения рассмотрю.", [
      fact("job_search", "интересные предложения рассмотрю", { label: "passive" }, { assertion: "inferred", confidence: 0.99 }),
    ]);
    expect(r.accepted[0]!.confidence).toBe(0.6);
  });
  it("trait detector distinguishes qualities from roles/scope", () => {
    for (const t of ["сильный лидер", "ответственный", "стрессоустойчивость", "очень пунктуальный"]) expect(isEvaluativeTrait(t), t).toBe(true);
    for (const t of ["ответственный за закупки", "исполнительный директор", "лидер продаж", "руководитель отдела"]) expect(isEvaluativeTrait(t), t).toBe(false);
  });
});

describe("precedence: user corrected > user confirmed > AI", () => {
  const t = (s: string) => new Date(s);
  const c = (id: string, userDecision: string | null, source: string, decided: string | null = null) =>
    ({ id, slotKey: "compensation", userDecision, decidedAt: decided ? t(decided) : null, sourceCreatedAt: t(source), createdAt: t(source) });
  it("a confirmed older fact beats a newer AI fact; a correction beats both", () => {
    expect(planSlotResolution([c("ai-new", null, "2026-06-01"), c("confirmed-old", "confirmed", "2026-01-01", "2026-02-01")]).get("confirmed-old")!.status).toBe("active");
    const plan = planSlotResolution([c("ai-new", null, "2026-06-01"), c("confirmed", "confirmed", "2026-05-01", "2026-05-02"), c("corrected", "corrected", "2026-01-01", "2026-01-02")]);
    expect(plan.get("corrected")).toEqual({ status: "active", supersededBy: null });
    expect(plan.get("confirmed")).toEqual({ status: "superseded", supersededBy: "corrected" });
    expect(plan.get("ai-new")).toEqual({ status: "superseded", supersededBy: "corrected" });
  });
  it("within the same precedence the later message wins", () => {
    const plan = planSlotResolution([c("a", "confirmed", "2026-01-01", "2026-09-01"), c("b", "confirmed", "2026-06-01", "2026-06-02")]);
    expect(plan.get("b")!.status).toBe("active");
  });
});

describe("label grounding tolerates inflection", () => {
  it("поднятие тяжестей ~ не поднимаю тяжести; ритейл still rejected", () => {
    expect(labelSupported("поднятие тяжестей", "не поднимаю больше 10 кг")).toBe(true);
    expect(labelSupported("ритейл", "Последние четыре года был коммерческим директором, управлял отделом около 60 человек")).toBe(false);
    expect(labelSupported("MBA", "был коммерческим директором")).toBe(false);
  });
});
