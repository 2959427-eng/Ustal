import { expect, it, vi } from "vitest";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ustal/config", () => ({ loadEnv: () => ({ OPENAI_API_KEY: "test", AI_MODEL_EXTRACTION: "extract-test", AI_MODEL_SEMANTIC_REVIEW: "review-test", AI_MODEL_NORMALIZATION: "norm-test" }) }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create } }; }, toFile: vi.fn() }));
import { openAiExtraction } from "./openai.js";
const meta = { operationType: "matching_normalization", traceId: "test", promptVersion: "v1", schemaVersion: "v1" };
const base = { constraintType: "availability", constraintScope: "whole_task", resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null },
  evidence: "source_0", canonicalKeys: [], confidence: 0.9, mandatory: false, startHour: null, endHour: null, refusalIntent: null, label: null, attributes: [] };
async function normalize(kind: "profile" | "order", text: string, fact: Record<string, unknown>) {
  create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ facts: [{ ...base, phrase: text, ...fact }], ...(kind === "order" ? { physicalConstraints: [] } : {}) }) } }] });
  return (await openAiExtraction.normalizeMatching({ kind, text, extracted: {}, ontology: [] }, meta)).data.facts[0]!;
}

it("the wire schema asks for an explicit daysMode on every fact (strict, required)", async () => {
  await normalize("profile", "Не работаю по воскресеньям", { kind: "availability", daysOfWeek: [6], daysMode: "excluded" });
  const schema = create.mock.lastCall![0].response_format.json_schema.schema;
  const item = schema.properties.facts.items;
  expect(item.required).toContain("daysMode");
  expect(JSON.stringify(item.properties.daysMode)).toContain("excluded");
  expect(create.mock.lastCall![0].messages[0].content).toMatch(/daysMode/);
});
it("global availability: «Не работаю по воскресеньям» excluded [6] → allowed пн–сб", async () => {
  const f = await normalize("profile", "Не работаю по воскресеньям", { kind: "availability", daysOfWeek: [6], daysMode: "excluded" });
  expect(f.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5]);
  expect("daysMode" in f).toBe(false); // downstream sees only allowed days
});
it("scoped refusal: «Не копаю по воскресеньям» excluded [6] → allowed пн–сб for that activity only (scope kept)", async () => {
  const f = await normalize("profile", "Не копаю по воскресеньям", { kind: "availability", constraintScope: "fact", canonicalKeys: [], daysOfWeek: [6], daysMode: "excluded" });
  expect(f).toMatchObject({ constraintScope: "fact", daysOfWeek: [0, 1, 2, 3, 4, 5] });
});
it("permissive statement without «только»: no day restriction", async () => {
  const f = await normalize("profile", "Могу работать по воскресеньям", { kind: "availability", daysOfWeek: [6], daysMode: null });
  expect(f.daysOfWeek).toBeNull();
});
it("orders use the same contract", async () => {
  const f = await normalize("order", "Нужно в любой день, кроме воскресенья", { kind: "availability", daysOfWeek: [6], daysMode: "excluded" });
  expect(f.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5]);
});
