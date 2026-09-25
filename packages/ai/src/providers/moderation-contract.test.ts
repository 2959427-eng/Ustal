import { expect, it, vi } from "vitest";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ustal/config", () => ({
  loadEnv: () => ({ OPENAI_API_KEY: "test", AI_MODEL_EXTRACTION: "extract-test", AI_MODEL_SEMANTIC_REVIEW: "review-test" }),
}));
vi.mock("openai", () => ({ default: class { chat = { completions: { create } }; }, toFile: vi.fn() }));
import { openAiModeration, openAiExtraction } from "./openai.js";

const meta = { operationType: "order_moderation", traceId: "test", promptVersion: "v1", schemaVersion: "v1" };

// Product rule (checkpoint-regulated-gate.md): USTAL does not check licenses/permits
// and regulated must never be the reason for manual_review/reject. This used to be
// enforced in two extra places beyond matching: the SYSTEM_PROMPT_MODERATION
// instruction, and a post-hoc override forcing manual_review whenever regulated was
// true. Both are gone now — moderate() no longer even accepts a regulated input.

it("не упоминает regulated ни в системном промпте, ни в тексте пользователя", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ decision: "allow", reason: "ok" }) } }] });
  await openAiModeration.moderate({ text: "Почини проводку в квартире", riskLevel: 1 }, meta);
  const request = create.mock.lastCall![0];
  expect(request.messages[0].content).not.toContain("regulated");
  expect(request.messages[1].content).not.toContain("regulated");
});

it("возвращает решение модели как есть, без принудительной эскалации allow → manual_review", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ decision: "allow", reason: "ok" }) } }] });
  const result = await openAiModeration.moderate({ text: "Почини проводку в квартире", riskLevel: 1 }, meta);
  expect(result.data).toEqual({ decision: "allow", reason: "ok" });
});

it("возвращает allow_with_warning без изменений — раньше принудительно менялось на manual_review при regulated=true", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ decision: "allow_with_warning", reason: "тяжёлая работа" }) } }] });
  const result = await openAiModeration.moderate({ text: "Работа на высоте", riskLevel: 1 }, meta);
  expect(result.data).toEqual({ decision: "allow_with_warning", reason: "тяжёлая работа" });
});

it("manual_review/reject от модели по-прежнему проходят без изменений", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ decision: "reject", reason: "мошенничество" }) } }] });
  const result = await openAiModeration.moderate({ text: "Подозрительный текст", riskLevel: 0 }, meta);
  expect(result.data).toEqual({ decision: "reject", reason: "мошенничество" });
});


it("recall review keeps specialization, qualification and batch capacity separate from explicit conflicts", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ compatible:true, confidence:0.95, reason:"Relevant related work" }) } }] });
  const result=await openAiExtraction.reviewSemantic({profile:["Related work experience; small van"],order:["Larger workload"]},meta);
  const prompt=create.mock.lastCall![0].messages[0].content;
  expect(prompt).toContain("Missing information is not negative evidence");
  expect(prompt).toContain("different license category alone must NOT produce compatible=false");
  expect(prompt).toContain("Several trips or batches");
  expect(prompt).toContain("refusing taxi work does not prohibit all driving");
  expect(prompt).toContain("required full shift must fit");
  expect(result.data.compatible).toBe(true);
});
it("lawful marketing is not moderated on speculative wrongdoing", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ decision:"allow",reason:"Legal SEO" }) } }] });
  await openAiModeration.moderate({text:"SEO",riskLevel:0},meta);
  const prompt=create.mock.lastCall![0].messages[0].content;
  expect(prompt).toContain("reject требует явных признаков");
  expect(prompt).toContain("Отсутствие деталей само по себе не нарушение");
});
