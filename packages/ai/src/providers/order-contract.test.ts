import { expect, it, vi } from "vitest";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ustal/config", () => ({ loadEnv: () => ({ OPENAI_API_KEY: "test", AI_MODEL_EXTRACTION: "extract-test", AI_MODEL_SEMANTIC_REVIEW: "review-test" }) }));
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
  const before = create.mock.calls.length;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  create.mockResolvedValue({ choices: [{ message: { content: '{"normalizedTitle":"private text"}' } }] });
  await expect(openAiExtraction.extractOrder({ text: "Task" }, meta)).rejects.toThrow();
  expect(create.mock.calls.length - before).toBe(3);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private text");
  log.mockRestore();
});
it("repairs invalid evidence IDs, restores exact source and accounts for every attempt", async () => {
  const text = "Умею ухаживать за розами и пионами";
  const fact = { kind: "capability", constraintType: "none", constraintScope: "fact", resourceRole: "none", resourceCapacity: {value:null,unit:null,kind:null}, phrase: "уход за растениями", evidence: "Умею ухаживать за пионами", canonicalKeys: [], confidence: .9, mandatory: false, startHour: null, endHour: null };
  const response = (evidence: string) => ({ choices: [{ message: { content: JSON.stringify({ facts: [{ ...fact, evidence }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  create.mockResolvedValueOnce(response("source_99")).mockResolvedValueOnce(response("source_0"));
  const before = create.mock.calls.length;
  const result = await openAiExtraction.normalizeMatching({ kind: "profile", text, extracted: {}, ontology: [] }, meta);
  expect(result.data.facts[0]?.evidence).toBe(text);
  expect(result.validationAttempts).toBe(2);
  expect(result.tokensInput).toBe(20);
  expect(result.tokensOutput).toBe(6);
  expect(create.mock.calls.length - before).toBe(2);
  expect(create.mock.lastCall![0].messages[2].content).toContain("EVIDENCE_SPANS");
  expect(create.mock.lastCall![0].response_format.json_schema.schema.properties.facts.items.properties.evidence.enum).toEqual(["source_0"]);
});
it("does not repair transport failures or provider refusals as malformed JSON", async () => {
  let before = create.mock.calls.length;
  create.mockRejectedValueOnce(new Error("transport unavailable"));
  await expect(openAiExtraction.normalizeMatching({ kind: "profile", text: "source", extracted: {}, ontology: [] }, meta)).rejects.toThrow("transport unavailable");
  expect(create.mock.calls.length - before).toBe(1);
  before = create.mock.calls.length;
  create.mockResolvedValueOnce({ choices: [{ message: { content: null, refusal: "Refused" } }] });
  await expect(openAiExtraction.normalizeMatching({ kind: "profile", text: "source", extracted: {}, ontology: [] }, meta)).rejects.toThrow("refused");
  expect(create.mock.calls.length - before).toBe(1);
});
it("restores the selected later span of a long source without truncating its evidence", async () => {
  const text = "Садовые работы. ".repeat(100);
  create.mockImplementationOnce(async request => {
    const spans = JSON.parse(request.messages[1].content).EVIDENCE_SPANS;
    expect(spans.length).toBeGreaterThan(1);
    return { choices: [{ message: { content: JSON.stringify({ facts: [{
      kind: "capability", constraintType: "none", constraintScope: "fact", resourceRole: "none", resourceCapacity: {value:null,unit:null,kind:null}, phrase: "садовые работы", evidence: spans[1].id,
      canonicalKeys: [], confidence: .9, mandatory: false, startHour: null, endHour: null,
    }] }) } }] };
  });
  const result = await openAiExtraction.normalizeMatching({ kind: "profile", text, extracted: {}, ontology: [] }, meta);
  const spans = JSON.parse(create.mock.lastCall![0].messages[1].content).EVIDENCE_SPANS;
  expect(result.data.facts[0]?.evidence).toBe(spans[1].text);
  expect(text).toContain(result.data.facts[0]!.evidence);
});
it("normalizes source only with strict nested kinds and ontology synonyms", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: '{"facts":[]}' } }] });
  await openAiExtraction.normalizeMatching({ kind: "order", text: "SOURCE only", extracted: { invented: "UNTRUSTED_AI_HINT" },
    ontology: [{canonicalKey:"loading",name:"погрузка",nodeType:"action",description:null,synonyms:["грузчик"]}] }, meta);
  const request = create.mock.lastCall![0], contract = request.response_format.json_schema;
  expect(contract.strict).toBe(true);
  expect(contract.schema.properties.facts.items.additionalProperties).toBe(false);
  expect(contract.schema.properties.facts.items.properties.kind.enum).toEqual(["capability","resource","exclude","availability"]);
  expect(contract.schema.properties.facts.items.required).toEqual(Object.keys(contract.schema.properties.facts.items.properties));
  expect(request.messages[1].content).not.toContain("UNTRUSTED_AI_HINT");
  expect(request.messages[1].content).toContain("грузчик");
});
it("uses the configured semantic reviewer and validates its result", async () => {
  create.mockResolvedValue({ choices: [{ message: { content: '{"compatible":false,"confidence":0.9,"reason":"Different activities"}' } }] });
  const result=await openAiExtraction.reviewSemantic({profile:["move files"],order:["move furniture"]},meta);
  expect(result.model).toBe("review-test");
  expect(create.mock.lastCall![0].model).toBe("review-test");
  expect(create.mock.lastCall![0].response_format.json_schema.strict).toBe(true);
  expect(result.data.compatible).toBe(false);
});
