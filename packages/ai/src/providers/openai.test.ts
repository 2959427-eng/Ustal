import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Тестируем только то, что не требует сетевого вызова к OpenAI (реального
 * ключа в этой песочнице нет) — сборку клиента и явную ошибку при отсутствии
 * OPENAI_API_KEY. Structured Outputs/STT/embeddings против реальной API
 * должны быть перепроверены вручную с боевым ключом (см. AI_HANDOFF.md).
 */
const BASE_ENV = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  AI_PROVIDER: "openai",
};

describe("openai provider — client construction", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("AI_PROVIDER=openai без OPENAI_API_KEY бросает явную ошибку при первом реальном вызове, не раньше", async () => {
    Object.assign(process.env, BASE_ENV);
    delete process.env.OPENAI_API_KEY;
    const { getAiProviders } = await import("../index.js");

    // getAiProviders() сам по себе не должен падать — клиент создаётся лениво.
    const providers = getAiProviders();
    expect(providers).toBeDefined();

    await expect(providers.embedding.embed(["текст"], { operationType: "test", traceId: "t1", promptVersion: "v1", schemaVersion: "v1" })).rejects.toThrow(
      /OPENAI_API_KEY не задан/,
    );
  });

  it("moderateWithRules — жёсткий запрет по ключевому слову не требует ключа вообще", async () => {
    Object.assign(process.env, BASE_ENV);
    delete process.env.OPENAI_API_KEY;
    const { moderateWithRules } = await import("./openai.js");
    const result = moderateWithRules("продам оружие недорого");
    expect(result.decision).toBe("reject");
  });

  it("AI_PROVIDER=mock (по умолчанию) возвращает mock-бандл и не требует OPENAI_API_KEY", async () => {
    Object.assign(process.env, BASE_ENV, { AI_PROVIDER: "mock" });
    delete process.env.OPENAI_API_KEY;
    const { getAiProviders } = await import("../index.js");
    const providers = getAiProviders();
    const result = await providers.embedding.embed(["x"], { operationType: "test", traceId: "t1", promptVersion: "v1", schemaVersion: "v1" });
    expect(result.provider).toBe("mock");
  });

  it("OPENAI_BASE_URL валидируется как URL в общем env-контракте", async () => {
    Object.assign(process.env, BASE_ENV, {
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "https://ai-relay.ustal.example/v1",
    });
    const { loadEnv } = await import("@ustal/config");
    expect(loadEnv().OPENAI_BASE_URL).toBe("https://ai-relay.ustal.example/v1");
  });
});
