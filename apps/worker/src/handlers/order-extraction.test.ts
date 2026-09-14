import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  find: vi.fn(), extract: vi.fn(), set: vi.fn(), where: vi.fn(),
}));
vi.mock("@ustal/database", () => ({
  getDb: () => ({ query: { orders: { findFirst: mocks.find } }, update: () => ({ set: mocks.set }) }),
  schema: { orders: { id: "id", status: "status" } },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock("@ustal/config", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("@ustal/ai", () => ({ getAiProviders: () => ({ extraction: { extractOrder: mocks.extract } }), buildAiRunRecord: vi.fn(), moderateWithRules: vi.fn() }));
vi.mock("@ustal/ontology", () => ({ createOntologyCandidate: vi.fn(), findOntologyNodeForPhrase: vi.fn() }));
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
