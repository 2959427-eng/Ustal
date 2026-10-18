import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { assertLocalTestDatabase, getSql } from "@ustal/database";
import { _clearLoginThrottleForTests } from "./lib/login-throttle.js";

process.env.TRUST_PROXY_HOPS = "1"; // как в проде: перед API один прокси (Caddy)
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-0123456789";
assertLocalTestDatabase();

let app: FastifyInstance;
beforeAll(async () => {
  const { buildApp } = await import("./app.js");
  app = await buildApp();
  app.get("/whoami", async (request) => ({ ip: request.ip }));
  await app.ready();
});
beforeEach(() => _clearLoginThrottleForTests());
afterAll(async () => {
  await app.close();
  await getSql().end();
});

const CADDY = "172.18.0.5";
const login = (xff: string, phone = "+79990000001") =>
  app.inject({
    method: "POST",
    url: "/auth/login",
    remoteAddress: CADDY,
    headers: { "x-forwarded-for": xff },
    payload: { phone, password: "wrong-password" },
  });

it("real client IP is taken from the proxy hop, a forged X-Forwarded-For prefix is ignored", async () => {
  const res = await app.inject({ method: "GET", url: "/whoami", remoteAddress: CADDY, headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" } });
  expect(res.json().ip).toBe("203.0.113.7");
});

it("rate limit is per client, not one shared counter for everyone behind the proxy", async () => {
  for (let i = 0; i < 10; i++) expect((await login("203.0.113.10", `+7999000${1000 + i}`)).statusCode).toBe(401);
  expect((await login("203.0.113.10", "+79990002000")).statusCode).toBe(429); // клиент A исчерпал лимит
  expect((await login("203.0.113.11", "+79990002001")).statusCode).toBe(401); // клиент B не задет
  // подмена первого элемента цепочки не сбрасывает счётчик клиента A
  expect((await login("1.1.1.1, 203.0.113.10", "+79990002002")).statusCode).toBe(429);
});

it("password guessing on one phone is throttled even when the attacker rotates IPs", async () => {
  for (let i = 0; i < 10; i++) expect((await login(`198.51.100.${i + 1}`)).statusCode).toBe(401);
  const res = await login("198.51.100.200");
  expect(res.statusCode).toBe(429);
  expect(res.json().error.code).toBe("too_many_attempts");
});
