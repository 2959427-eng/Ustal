import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  find: vi.fn(), extract: vi.fn(), set: vi.fn(), where: vi.fn(),
  moderate: vi.fn(), txSet: vi.fn(),
}));
vi.mock("@ustal/database", () => {
  const tx = {
    select: () => tx, from: () => tx, where: () => tx,
    for: async () => [{ status: "processing", sourceText: "test" }],
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: (v: unknown) => { mocks.txSet(v); return { where: async () => undefined }; } }),
  };
  return {
    getDb: () => ({
      query: { orders: { findFirst: mocks.find }, matchingDocuments: { findFirst: async () => undefined } },
      update: () => ({ set: mocks.set }),
      insert: () => ({ values: async () => undefined }),
      transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    }),
    schema: {
      orders: { id: "id", status: "status" },
      matchingDocuments: { orderId: "orderId" },
      moderationCases: {}, orderAiExtractions: {}, orderEmbeddings: { orderId: "orderId" }, aiRuns: {},
    },
  };
});
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock("@ustal/config", () => ({ getRuntimeConfig: () => ({ ai: { models: { embedding: "test" } } }) }));
vi.mock("@ustal/ai", () => ({
  getAiProviders: () => ({
    extraction: { extractOrder: mocks.extract },
    moderation: { moderate: mocks.moderate },
    embedding: { embed: async () => ({ data: { vectors: [null] } }) },
  }),
  buildAiRunRecord: vi.fn(),
  moderateWithRules: () => ({ decision: undefined, reason: undefined }),
}));
vi.mock("@ustal/ontology", () => ({ createOntologyCandidate: vi.fn(), findOntologyNodeForPhrase: vi.fn() }));
vi.mock("@ustal/validation", () => ({ orderExtractionResultSchema: { parse: (x: unknown) => x },
  // «Простые задачи» (2026-10-15): классификация доступа; её сбой не роняет извлечение заказа.
  orderAccessSchema: { parse: (x: unknown) => x }, ORDER_ACCESS_VERSION: "order-access-v1" }));
vi.mock("../semantic.js", () => ({ prepareDocument: vi.fn(async () => ({})), persistDocument: vi.fn(async () => ({ reused: false })), recordUnknownConcepts: vi.fn(async () => undefined) }));
import { handleOrderExtraction } from "./order-extraction.js";

it("marks an extraction exception as a technical failure, leaves moderation unchanged, and fails the job", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.find.mockResolvedValue({ id: "order", sourceText: "test", status: "processing" });
  mocks.extract.mockRejectedValue(new Error("model unavailable"));
  mocks.set.mockReturnValue({ where: mocks.where });
  await expect(handleOrderExtraction({ id: "job", data: { orderId: "order" } } as never)).rejects.toThrow("openai:start");
  expect(mocks.set).toHaveBeenCalledWith({ status: "processing_failed" });
  expect(error).toHaveBeenCalledWith("[order-extraction:error]", expect.objectContaining({ jobId: "job", orderId: "order", stage: "openai:start" }));
  info.mockRestore(); error.mockRestore();
});

it("does not force manual_review or raise riskLevel for a regulated order (product rule: no license/permit checks)", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.find.mockResolvedValue({ id: "order", sourceText: "test", status: "processing" });
  mocks.extract.mockResolvedValue({
    data: { regulated: true, requiresQualification: false, normalizedTitle: "t", normalizedDescription: "d" },
  });
  mocks.moderate.mockResolvedValue({ data: { decision: "allow", reason: "ok" } });
  const result = await handleOrderExtraction({ id: "job", data: { orderId: "order" } } as never);
  expect(result).toMatchObject({ moderationDecision: "allow", status: "processing" });
  // regulated больше не участвует в модерации (product rule): moderate() вызывается
  // только с text/riskLevel, без поля regulated, даже когда extraction вернул regulated=true.
  expect(mocks.moderate).toHaveBeenCalledWith(
    { text: "test", riskLevel: 0 },
    expect.any(Object),
  );
  expect(mocks.txSet).toHaveBeenCalledWith(
    expect.objectContaining({ riskLevel: 0, moderationStatus: "allow", status: "processing" }),
  );
  info.mockRestore();
});
