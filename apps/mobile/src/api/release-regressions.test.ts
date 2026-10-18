import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "@ustal/api-client";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const configure = require("../../app.config.js");
const base = require("../../app.json").expo;

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("release configuration", () => {
  it.each(["http://api.example.com", "https://localhost", "https://127.1", "https://10.1.2.3", "https://172.30.1.36", "https://192.168.1.2", "https://[::1]", "https://[fc00::1]", "https://127-0-0-1.sslip.io"])("rejects unsafe production URL %s", (url) => {
    vi.stubEnv("EAS_BUILD_PROFILE", "production");
    vi.stubEnv("USTAL_API_URL", url);
    vi.stubEnv("EAS_PROJECT_ID", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(() => configure({ config: base })).toThrow();
  });
  it("keeps LAN development working", () => {
    vi.stubEnv("EAS_BUILD_PROFILE", ""); vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("USTAL_API_URL", "http://192.168.1.5:4000");
    expect(configure({ config: base }).extra.apiBaseUrl).toBe("http://192.168.1.5:4000");
  });
});

describe("transport isolation", () => {
  it("bounds a hung request, including a fetch implementation that ignores abort", async () => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const client = new ApiClient({ baseUrl: "https://api.example.com", getAccessToken: () => null });
    const result = client.request("/me").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toBeInstanceOf(Error);
  });
});

 it("accepts the reviewed HTTPS origin and requires a real project setting", () => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("USTAL_API_URL", "https://api.104-171-139-154.sslip.io");
  vi.stubEnv("EAS_PROJECT_ID", "");
  expect(() => configure({ config: base })).toThrow("EAS_PROJECT_ID");
  vi.stubEnv("EAS_PROJECT_ID", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  expect(configure({ config: base }).extra.release).toBe(true);
});
it("cancelAll rejects a late A result and does not retry it with B credentials", async () => {
  let complete!: (response: Response) => void;
  let token = "A";
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  const refresh = vi.fn(async () => true);
  const client = new ApiClient({ baseUrl: "https://api.example.com", getAccessToken: () => token, refreshAccessToken: refresh });
  const pending = client.request("/private").catch((e: Error) => e);
  client.cancelAll(); token = "B";
  complete(new Response("{}", { status: 401 }));
  expect(await pending).toBeInstanceOf(Error);
  expect(refresh).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("times out while reading a stalled response body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })));
  const client = new ApiClient({ baseUrl: "https://api.example.com", getAccessToken: () => null, timeoutMs: 100 });
  const pending = client.request("/private").catch((e: Error) => e);
  await vi.advanceTimersByTimeAsync(101);
  expect(await pending).toMatchObject({ message: "Network request timed out" });
});
