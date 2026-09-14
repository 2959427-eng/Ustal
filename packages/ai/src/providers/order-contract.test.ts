import { expect, it, vi } from "vitest";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ustal/config", () => ({ loadEnv: () => ({ OPENAI_API_KEY: "test" }) }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create } }; }, toFile: vi.fn() }));
import { openAiExtraction } from "./openai.js";
const meta = { operationType: "order_extraction", traceId: "test", promptVersion: "v1", schemaVersion: "v1" };
it("requires every order field in strict mode, including actions and defaulted arrays", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    normalizedTitle: "Task", normalizedDescription: "Task", actions: [], requiredCapabilities: [],
    desiredCapabilities: [], requiredResources: [], desiredResources: [], physicalRequirements: [],
    contextualChips: [], complexity: "low", regulated: false, requiresQualification: false, estimatedDurationMinutes: null,
  }) } }] });
  await openAiExtraction.extractOrder({ text: "Task" }, meta);
  const contract = create.mock.calls[0]![0].response_format.json_schema;
  expect(contract.strict).toBe(true);
  expect(contract.schema.additionalProperties).toBe(false);
  expect(contract.schema.required).toEqual(Object.keys(contract.schema.properties));
  expect(contract.schema.required).toContain("actions");
});
it("rejects a missing actions field instead of accepting malformed model data", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  create.mockResolvedValue({ choices: [{ message: { content: '{"normalizedTitle":"private text"}' } }] });
  await expect(openAiExtraction.extractOrder({ text: "Task" }, meta)).rejects.toThrow();
  expect(JSON.stringify(log.mock.calls)).not.toContain("private text");
  log.mockRestore();
});
