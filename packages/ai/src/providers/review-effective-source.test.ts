import { beforeEach, describe, expect, it, vi } from "vitest";
const { create, plan } = vi.hoisted(() => ({ create: vi.fn(), plan: { action: null as string | null, profileEvidence: "" } }));
vi.mock("@ustal/config", () => ({ loadEnv: () => ({ OPENAI_API_KEY: "test", AI_MODEL_SEMANTIC_REVIEW: "review-test" }) }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create } }; }, toFile: vi.fn() }));
import { openAiExtraction } from "./openai.js";
import { liftRestrictionFacts, revokeProfileItem, itemKey, type ItemFact } from "@ustal/matching";
// The producer of the effective review source lives in the worker; imported by path (test only).
const WORKER = "../../../../apps/worker/src/profile-restrictions.js";
const { reviewProfileText } = (await import(/* @vite-ignore */ WORKER)) as { reviewProfileText: (s: string, f: unknown[]) => string };

/**
 * Live E2E FAIL (2026-10-17): после «Убрать»/«Снять ограничение» review падал с EVIDENCE_VALIDATION_ERROR на
 * синтетическом тексте профиля. Настоящий review pipeline (@ustal/ai reviewSemantic, строгая проверка цитат);
 * подменены только ответы модели — в том числе тот, что дал живой verifier глагола («Реставрация»).
 */
const D = "55555555-5555-5555-5555-555555555555", P = "66666666-6666-6666-6666-666666666666", DRILL = "77777777-7777-7777-7777-777777777777";
const f = (o: Partial<ItemFact>): ItemFact => ({ kind: "capability", phrase: "", nodeIds: [], embedding: [1, 0], mandatory: false, confidence: 0.95,
  constraintType: "none", constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  startHour: null, endHour: null, daysOfWeek: null, label: null, evidence: "", ...o } as ItemFact);
const MSG = "Сверлю бетон и крашу стены. Есть дрель. Не работаю после 18:00. Реставрирую виниловые пластинки до 21:00.";
const meta = { operationType: "semantic_pair_review", traceId: "t", promptVersion: "t", schemaVersion: "v1" };
beforeEach(() => {
  create.mockReset();
  create.mockImplementation(async (request: any) => {
    const name = request.response_format.json_schema.name;
    const data = name === "semantic_review_v1" ? { compatible: true, confidence: 0.9, reason: "Профиль: малярные работы", hardConflict: null, numericLimits: [], exclusiveScope: null }
      : name === "source_action_verb_v1" ? { actionVerbEvidence: plan.action }
      : name === "main_result_verification_v1" ? { compatible: true, confidence: 0.9, reason: "Покраска стен", onlySubstep: false, differentCoreOperation: false,
        sharedFieldOnly: false, unrelatedSpecialistDomain: false, specialistDomainEvidence: null, concreteActivityEvidence: true, broadRoleEvidence: null,
        profileEvidence: plan.profileEvidence, orderEvidence: "покрасить стены", profileOperation: "operate", orderOperation: "operate" }
      : undefined;
    if (data === undefined) throw new Error("Unexpected model operation: " + name);
    return { choices: [{ message: { content: JSON.stringify(data) } }] };
  });
});

/** Живое состояние E: сверление и дрель убраны, «до 18:00» снято; покраска и пластинки (до 21:00) действуют. */
function liveState() {
  let facts: ItemFact[] = [
    f({ phrase: "Сверлю бетон", label: "Сверление бетона", evidence: MSG, nodeIds: [DRILL], endHour: 18 }),
    f({ phrase: "крашу стены", label: "Малярные работы", evidence: MSG, nodeIds: [P], endHour: 18 }),
    f({ kind: "resource", phrase: "дрель", label: "Дрель", evidence: MSG, nodeIds: [D], resourceRole: "available" }),
    f({ kind: "availability", constraintType: "availability", phrase: "Не работаю после 18:00", evidence: MSG, endHour: 18 }),
    f({ phrase: "Реставрирую виниловые пластинки", label: "Реставрация виниловых пластинок", evidence: MSG, endHour: 21 }),
  ];
  const nodeLabel = (id: string) => (id === P ? "Малярные работы" : id === DRILL ? "Сверление бетона" : null);
  facts = liftRestrictionFacts(facts, (x) => x.endHour === 18, { nodeLabel }).facts;
  facts = revokeProfileItem(facts, { family: "capability", nodeIds: [DRILL], key: itemKey("Сверление бетона") }, { nodeLabel }).facts;
  facts = revokeProfileItem(facts, { family: "resource", nodeIds: [D], key: itemKey("Дрель") }, { nodeLabel }).facts;
  return facts;
}
const review = (profile: string) => openAiExtraction.reviewSemantic({ profile: [profile], order: ["Нужно покрасить стены в комнате, начать сегодня в 20:00"], profileHasUpdates: true }, meta);

describe("review on the effective (synthetic) profile source", () => {
  it("live repro: the verb verifier quotes «Реставрация» — the review succeeds (no EVIDENCE_VALIDATION_ERROR)", async () => {
    const text = reviewProfileText(MSG, liveState() as never);
    expect(text).not.toMatch(/Сверл|сверл|дрел|18/);
    plan.action = "Реставрация"; plan.profileEvidence = "Малярные работы";
    await expect(review(text)).resolves.toMatchObject({ data: { compatible: true } });
  });
  it("the painting action is quotable as grounded evidence, the availability of another skill is a separate fragment", async () => {
    const text = reviewProfileText(MSG, liveState() as never);
    for (const quote of ["выполнять", "Малярные работы", "Реставрация виниловых пластинок"]) {
      plan.action = quote; plan.profileEvidence = quote;
      await expect(review(text)).resolves.toMatchObject({ data: { compatible: true } });
    }
  });

  const quotes = async (text: string, list: string[]) => {
    for (const quote of list) {
      plan.action = quote; plan.profileEvidence = quote;
      await expect(review(text)).resolves.toMatchObject({ data: { compatible: true } });
    }
  };
  it("A. «Сверлю бетон и крашу стены» → drilling removed: only painting, as an action sentence; the review succeeds", async () => {
    const M = "Сверлю бетон и крашу стены.";
    const facts = revokeProfileItem([f({ phrase: "сверлю бетон", label: "Сверление бетона", evidence: M, nodeIds: [DRILL] }), f({ phrase: "крашу стены", label: "Малярные работы", evidence: M, nodeIds: [P] })],
      { family: "capability", nodeIds: [DRILL], key: itemKey("Сверление бетона") }).facts;
    const text = reviewProfileText(M, facts as never);
    expect(text).toBe("Могу выполнять: Малярные работы.");
    await quotes(text, ["выполнять", "Малярные работы"]);
  });
  it("B. active skill with its own hours: action and availability are separate fragments", async () => {
    const M = "Реставрирую пластинки до 21:00. Есть дрель.";
    const facts = revokeProfileItem([f({ phrase: "реставрирую пластинки", label: "Реставрация пластинок", evidence: M, endHour: 21 }),
      f({ kind: "resource", phrase: "дрель", label: "Дрель", evidence: M, nodeIds: [D], resourceRole: "available" })], { family: "resource", nodeIds: [D], key: itemKey("Дрель") }).facts;
    const text = reviewProfileText(M, facts as never);
    expect(text.split("\n")).toEqual(["Могу выполнять: Реставрация пластинок.", "Ограничение времени для «Реставрация пластинок»: до 21:00; на другие работы оно не распространяется."]);
    await quotes(text, ["Реставрация пластинок", "выполнять", "до 21:00", "на другие работы оно не распространяется"]);
  });
  it("C/D. a lifted global window and a removed resource are absent from the source", () => {
    const text = reviewProfileText(MSG, liveState() as never);
    expect(text).not.toMatch(/18|дрел|ресурс/i);
  });
  it("E/F. no-node skill with an atomic label is an action sentence; a legacy no-label skill with a lifted limit is omitted — review does not fail", async () => {
    const M = "Мою окна до 20:00. Доставляю документы до 22:00.";
    const facts = liftRestrictionFacts([f({ phrase: "мою окна", label: "Мытьё окон", evidence: M, endHour: 20 }), f({ phrase: "доставляю документы до 22:00", evidence: M, endHour: 22 })],
      () => true, { nodeLabel: () => null }).facts;
    const text = reviewProfileText(M, facts as never);
    expect(text).toBe("Могу выполнять: Мытьё окон.");
    await quotes(text, ["Мытьё окон", "выполнять"]);
  });
  it("G. nothing removed: the raw text is used as is", () => {
    const M = "Крашу стены до 21:00.";
    expect(reviewProfileText(M, [f({ phrase: "крашу стены", evidence: M, endHour: 21 })] as never)).toBe(M);
  });
  it("H. mixed skills/resources/restrictions: verb verifier and evidence validation both pass for every item", async () => {
    const M = "Крашу стены и мою окна. Есть стремянка и дрель. Не беру заказы по воскресеньям. Не копаю.";
    let facts: ItemFact[] = [f({ phrase: "крашу стены", label: "Малярные работы", evidence: M, nodeIds: [P] }), f({ phrase: "мою окна", label: "Мытьё окон", evidence: M, endHour: 20 }),
      f({ kind: "resource", phrase: "стремянка", label: "Стремянка", evidence: M, resourceRole: "available" }), f({ kind: "resource", phrase: "дрель", label: "Дрель", evidence: M, nodeIds: [D], resourceRole: "available" }),
      f({ kind: "availability", constraintType: "availability", phrase: "Не беру заказы по воскресеньям", evidence: M, daysOfWeek: [0, 1, 2, 3, 4, 5] }),
      f({ kind: "exclude", constraintType: "exclusion", phrase: "копать", evidence: M, nodeIds: [DRILL] })];
    facts = revokeProfileItem(facts, { family: "resource", nodeIds: [D], key: itemKey("Дрель") }).facts;
    const text = reviewProfileText(M, facts as never);
    expect(text).not.toMatch(/Дрель/);
    expect(text).toMatch(/Не выполняю: копать\./);
    await quotes(text, ["Малярные работы", "Мытьё окон", "Стремянка", "выполнять"]);
  });
});

