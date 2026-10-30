import { expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";
/**
 * False positive 2026-10-30: «Я студент, хочу иногда подрабатывать, больше ничего нет» получил «Нужно сделать сайт»
 * (probable). Детерминированная часть: «по смыслу» без совпадений навыков пускает только профиль, у которого есть
 * навык или ресурс; требование-ресурс заказа само по себе дверь не открывает. Решение по навыку — за review.
 */
const f = (kind: string, phrase: string, extra: Partial<Fact> = {}): Fact => ({ kind, phrase, nodeIds: [], confidence: 0.9, mandatory: false, embedding: [1, 0], ...extra });
const webReq = f("capability", "разработка сайта", { nodeIds: ["web-dev"], mandatory: true, embedding: [0, 1] });
const pcReq = f("resource", "компьютер", { nodeIds: ["computer"], mandatory: true, resourceRole: "required", embedding: [0, 1] });
const positive = { compatible: true, confidence: 0.8, reason: "Может подойти", hardConflict: null };
const run = (caps: Fact[], reqs: Fact[], semanticReview?: typeof positive, reviewRequired = true) => evaluateSemantic({ capabilities: caps, requirements: reqs,
  relations: [], documentSimilarity: 0.3, riskLevel: 0, regulated: false, reviewRequired, semanticReview });

it("нет ни навыков, ни ресурсов, у заказа есть обязательный ресурс: положительный review больше не даёт совпадения", () => {
  expect(run([], [webReq, pcReq], positive)).toMatchObject({ matchType: null, reason: "insufficient_capability_evidence" });
  expect(run([], [webReq, f("resource", "ноутбук", { embedding: [0, 1] })], positive).matchType).toBeNull(); // ресурс без узла
});
it("нет навыков и ресурсов, только время/ограничения — тоже не совпадение", () => {
  const onlyTime = f("availability", "по выходным", { constraintType: "availability", daysOfWeek: [5, 6] });
  expect(run([onlyTime], [webReq, pcReq], positive).matchType).toBeNull();
});
it("ресурс-только профиль сохраняется: газель + перевозка с непроверенным обязательным ресурсом и review", () => {
  const truck = f("resource", "газель", { nodeIds: ["truck"], resourceRole: "available", resourceType: "vehicle" });
  const cargo = f("capability", "перевезти технику", { nodeIds: ["moving"], embedding: [0, 1] });
  const crane = f("resource", "кран-манипулятор", { nodeIds: ["crane"], mandatory: true, resourceRole: "required", resourceType: "equipment" });
  expect(run([truck], [cargo, crane], positive).matchType).toBe("probable");
});
it("ресурс с ролью compatibility в профиле тоже открывает дверь (не только available)", () => {
  const access = f("resource", "есть допуск на объект", { resourceRole: "compatibility" });
  expect(run([access], [webReq, pcReq], positive).matchType).toBe("probable");
});
it("явное «нет X» не считается ресурсом", () => {
  expect(run([f("resource", "нет компьютера", { resourceRole: "missing", embedding: [1, 0] })], [webReq], positive).matchType).toBeNull();
});
it("смежный навык и широкая профессия по-прежнему проходят через review (recall)", () => {
  expect(run([f("capability", "верстаю лендинги")], [webReq], positive).matchType).toBe("probable");
  expect(run([f("capability", "Программист")], [webReq, pcReq], positive).matchType).toBe("probable");
  expect(run([f("capability", "электрик", { nodeIds: ["electric"] })], [f("capability", "видеонаблюдение", { nodeIds: ["cctv"] })], positive, false).matchType).toBe("probable");
});
it("только статус/возраст/намерение («Студент», «Ищу подработку», «33 года», «Готов учиться»): положительный review не открывает специализированный заказ", () => {
  const student = [f("capability", "Студент"), f("capability", "Хочу иногда подрабатывать"), f("capability", "33 года"), f("capability", "Готов учиться")];
  expect(run(student, [webReq], positive)).toMatchObject({ matchType: null, reason: "insufficient_capability_evidence" });
  expect(run(student, [webReq, pcReq], positive).matchType).toBeNull();
  expect(run([f("capability", "Студент")], [webReq], positive).matchType).toBeNull();
});
it("«Студент, делаю сайты» не превращается в пустой профиль; статус рядом с навыком не мешает", () => {
  expect(run([f("capability", "Студент, делаю сайты")], [webReq], positive).matchType).toBe("probable");
  expect(run([f("capability", "Студент"), f("capability", "делаю сайты")], [webReq], positive).matchType).toBe("probable");
  expect(run([f("capability", "студент-дизайнер")], [webReq], positive).matchType).toBe("probable");
});
it("статус + ресурс: ресурс профиля открывает дверь там, где заказ про ресурс (как до исправления); иначе — нет", () => {
  const laptop = f("resource", "есть ноутбук", { resourceRole: "available" });
  expect(run([f("capability", "Студент"), laptop], [webReq, pcReq], positive).matchType).toBe("probable");
  expect(run([f("capability", "Студент"), laptop], [webReq], positive).matchType).toBeNull();
});
it("широкие профессии и переносимый опыт сохраняются (recall)", () => {
  const pairs: [string, string][] = [["настраиваю интернет-рекламу", "найти блогеров для рекламы"], ["Фотограф", "видеосъёмка свадьбы"],
    ["художник", "цифровой дизайн"], ["садовник", "ландшафтный дизайн участка"], ["Верстальщик", "разработка сайта"]];
  for (const [cap, req] of pairs)
    expect(run([f("capability", cap)], [f("capability", req, { nodeIds: ["x"], embedding: [0, 1] })], positive).matchType, cap).toBe("probable");
});
it("без положительного review статус-профиль и раньше не проходил — поведение не менялось", () => {
  expect(run([f("capability", "Студент")], [webReq], { ...positive, compatible: false, confidence: 0.9, hardConflict: { kind: "domain", profileEvidence: "студент", orderEvidence: "сделать сайт" } } as never).matchType).toBeNull();
});
