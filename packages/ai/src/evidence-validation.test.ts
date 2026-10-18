import { expect, it } from "vitest";
import { isGroundedEvidence, assertGroundedEvidence, EvidenceValidationError } from "./evidence-validation.js";

it.each([
  ["can lift 15 kg", "can lift 15 kg"],
  ["CAN lift: 15 KG!", "Can lift 15 kg."],
  ["I can lift a maximum of 15 kg", "can lift no more than 15 kg"],
  ["максимум 15кг", "не более 15 кг"],
  ["без иностранных языков", '{"skill":"секретарь","constraints":"без иностранных языков"}'],
  ['"requirements": ["английский"]', '{"requirements":["английский"]}'],
  ['"constraints":"без иностранных языков"', '{"experience":"3 года","constraints":"без иностранных языков"}'],
  ["2D ONLY", "2D only"],
  ["cannot lift 50 kg", "I cannot lift 50 kg"],
  ["15.5 kg", "15,5 kg"],
  ["60 слов/мин", "60слов/мин"],
])("accepts source-preserving evidence: %s", (quote, source) => {
  expect(isGroundedEvidence(quote, [source])).toBe(true);
});

it.each([
  ["can lift 50 kg", "can lift no more than 15 kg"],
  ["can lift 15 kg", "cannot lift 15 kg"],
  ["can lift 15 kg", "can lift no more than 15 kg"],
  ["не менее 15 кг", "не более 15 кг"],
  ["с иностранными языками", "без иностранных языков"],
  ["fluent English", "secretary"],
  ["3D only", "2D only"],
  ["15 g", "15 kg"],
  ["120 words/min", "60 words/min"],
  ["math teacher", "history teacher"],
  ["category D", "category B"],
  ["category A", "category B"],
  ["C# developer", "C++ developer"],
  ["Kazan", "Moscow"],
  ["2026-09-26", "2026-09-25"],
  ["15 kg", "-15 kg"],
  ["15 kg", "−15 kg"],
  ["lift 15 kg", "don't lift 15 kg"],
  ["lift 15 kg", "doesn't lift 15 kg"],
  ["lift 15 kg", "won't lift 15 kg"],
  ["15 kg", "< 15 kg"],
  ["<= 15 kg", "< 15 kg"],
  ["> 15 kg", "< 15 kg"],
  ["lift 15", "lift 15 kg"],
  ["15", "15%"],
  ["такси", "отказываюсь от такси"],
])("rejects fabricated, contradictory or weakened evidence: %s", (quote, source) => {
  expect(isGroundedEvidence(quote, [source])).toBe(false);
});

it("retains rejected evidence for case-level diagnosis without putting it in the error message", () => {
  try { assertGroundedEvidence("invented", ["source"], "profileEvidence"); throw new Error("not rejected"); }
  catch (error) {
    expect(error).toBeInstanceOf(EvidenceValidationError);
    expect(error).toMatchObject({ code: "EVIDENCE_VALIDATION_ERROR", diagnostic: { field: "profileEvidence", evidence: "invented", sources: ["source"] } });
    expect((error as Error).message).not.toContain("invented");
  }
});

// Stage 0 (career context, 2026-09-27): a literal quote spanning several sentences is compared with
// exactly the sentences it covers. Before the fix an unrelated number in another sentence ("от 500 тыс.")
// made the quote ungrounded -> reviewSemantic threw 3x -> the whole matching run of the order failed.
const careerProfile = "Бывший директор производства, управлял 300 сотрудниками. Есть Газель, права B/C, умею работать инструментом. Рассматриваю руководящие позиции от 500 тыс.";
it("accepts a multi-sentence literal quote that omits an unrelated numeric sentence", () => {
  expect(isGroundedEvidence("Бывший директор производства, управлял 300 сотрудниками. Есть Газель, права B/C, умею работать инструментом.", [careerProfile])).toBe(true);
  expect(isGroundedEvidence("Есть Газель, права B/C, умею работать инструментом. Рассматриваю руководящие позиции от 500 тыс.", [careerProfile])).toBe(true);
});
it("still rejects a multi-sentence quote that drops a number or negation inside the sentences it covers", () => {
  expect(isGroundedEvidence("Бывший директор производства, управлял сотрудниками. Есть Газель", [careerProfile])).toBe(false);
  expect(isGroundedEvidence("Не работаю ночью. Вожу грузы.", ["Работаю ночью. Вожу грузы. Есть Газель."])).toBe(false);
  expect(isGroundedEvidence("управлял 400 сотрудниками. Есть Газель", [careerProfile])).toBe(false);
});
