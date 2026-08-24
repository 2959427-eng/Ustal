import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

// Требует DATABASE_URL и переменные окружения из .env — запускается в CI
// с реальной PostgreSQL (см. .github/workflows/ci.yml).
describe("health check", () => {
  it("GET /health returns ok", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
