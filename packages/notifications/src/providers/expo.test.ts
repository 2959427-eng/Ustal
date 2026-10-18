import { afterEach, expect, it, vi } from "vitest";
vi.mock("@ustal/config", () => ({ loadEnv: () => ({ EXPO_ACCESS_TOKEN: undefined }) }));
import { expoPushProvider } from "./expo.js";
afterEach(() => vi.unstubAllGlobals());

it("classifies DeviceNotRegistered for deactivation without leaking provider text", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { status: "error", message: "sensitive provider text", details: { error: "DeviceNotRegistered" } } }))));
  const result = await expoPushProvider.send({ expoPushToken: "test", title: "Test", body: "Test" });
  expect(result).toMatchObject({ ok: false, invalidToken: true, error: "DeviceNotRegistered" });
});

it("HTTP failure must not count as an accepted notification", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { status: "ok", id: "ticket" } }), { status: 503 })));
  expect((await expoPushProvider.send({ expoPushToken: "test", title: "Test", body: "Test" })).ok).toBe(false);
});
