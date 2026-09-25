import { beforeEach, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: vi.fn() }));
const create = vi.fn();
vi.mock("openai", () => ({
  default: class { chat = { completions: { create } }; },
  toFile: vi.fn(),
}));

const profile = '{"skill":"уборщица","allergies":"не работаю с бытовой химией"}';
const order = '{"category":"уборка с химией","required":"бытовая химия"}';
const review = (orderEvidence: string) => ({ choices: [{ message: { content: JSON.stringify({
  numericLimits: [], exclusiveScope: null, compatible: false, confidence: .9, reason: "Отказ от бытовой химии",
  hardConflict: { kind: "exclusion", profileEvidence: "не работаю с бытовой химией", orderEvidence },
}) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

beforeEach(() => {
  create.mockReset();
  Object.assign(process.env, {
    DATABASE_URL: "postgres://user:pass@localhost:5432/db", JWT_ACCESS_SECRET: "a".repeat(32),
    JWT_REFRESH_SECRET: "b".repeat(32), AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-test-fixture",
  });
});

it("BH-066 pattern: evidence repair names the failing field and quote, and the corrected quote is accepted", async () => {
  create.mockResolvedValueOnce(review("требуется бытовая химия")).mockResolvedValueOnce(review("бытовая химия"));
  const { openAiExtraction } = await import("./openai.js");
  const result = await openAiExtraction.reviewSemantic({ profile: [profile], order: [order] } as never, {} as never);
  expect(create).toHaveBeenCalledTimes(2);
  const feedback = create.mock.calls[1]![0].messages.at(-1).content as string;
  expect(feedback).toContain('"orderEvidence"');
  expect(feedback).toContain('"требуется бытовая химия"');
  expect(feedback).toMatch(/contiguous substring.*Do not translate JSON field names/s);
  expect(result.data).toMatchObject({ compatible: false, hardConflict: { kind: "exclusion", orderEvidence: "бытовая химия" } });
});

const answer = (value: object) => ({ choices: [{ message: { content: JSON.stringify({ numericLimits: [], exclusiveScope: null, ...value }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
it.each([
  ['{"skill":"лётчик","category":"коммерческая авиация"}', '{"category":"дроны"}'],
  ['{"skill":"художник","medium":"масло"}', '{"category":"графический дизайн","medium":"digital"}'],
  ['{"skill":"водитель","license":"категория B"}', '{"category":"перевозка пассажиров","license":"категория D требуется"}'],
])("ungrounded negative verdict is repaired with the domain definition: %s -> %s", async (p, o) => {
  create.mockReset();
  create.mockResolvedValueOnce(answer({ compatible: false, confidence: 1, reason: "Другая область", hardConflict: null }))
    .mockResolvedValueOnce(answer({ compatible: true, confidence: .8, reason: "Смежная область", hardConflict: null }));
  const { openAiExtraction } = await import("./openai.js");
  const result = await openAiExtraction.reviewSemantic({ profile: [p], order: [o] } as never, {} as never);
  const feedback = create.mock.calls[1]![0].messages.at(-1).content as string;
  expect(feedback).toMatch(/genuinely unrelated subject areas/);
  expect(feedback).toMatch(/licenses, categories, levels, tools, media or specializations within a related field are NOT a domain conflict/);
  expect(result.data).toMatchObject({ compatible: true, hardConflict: null });
});
it("the main review prompt keeps adjacency recall-first and does not push domain conflicts", async () => {
  create.mockReset();
  create.mockResolvedValueOnce(answer({ compatible: true, confidence: .8, reason: "Смежная область", hardConflict: null }));
  const { openAiExtraction } = await import("./openai.js");
  await openAiExtraction.reviewSemantic({ profile: ['{"skill":"лётчик"}'], order: ['{"category":"дроны"}'] } as never, {} as never);
  const system = create.mock.calls[0]![0].messages[0].content as string;
  expect(system).toContain("An adjacent field, or a different tool, medium or specialization within reasonably related activity");
  expect(system).not.toContain("kind=domain for a clearly unrelated domain");
});
