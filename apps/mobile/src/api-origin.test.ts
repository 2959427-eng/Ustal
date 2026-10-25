import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { ApiClient } from "@ustal/api-client";

const require = createRequire(import.meta.url);
const { productionApiUrl, PRODUCTION_API_ORIGIN } = require("../config/api-url");
const configure = require("../app.config.js");
const base = require("../app.json").expo;
const eas = require("../eas.json");
const legacy = "https://api.104-171-139-154.sslip.io";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("reviewed production API origin", () => {
  it("keeps manifest, EAS profile and runtime validator on the same HTTPS origin", () => {
    expect(PRODUCTION_API_ORIGIN).toBe("https://api.ustal.site");
    expect(base.extra.apiBaseUrl).toBe(PRODUCTION_API_ORIGIN);
    expect(eas.build.production.env.USTAL_API_URL).toBe(PRODUCTION_API_ORIGIN);
    vi.stubEnv("EAS_BUILD_PROFILE", "production");
    vi.stubEnv("USTAL_API_URL", "");
    expect(configure({ config: structuredClone(base) }).extra.apiBaseUrl).toBe(PRODUCTION_API_ORIGIN);
    expect(productionApiUrl(PRODUCTION_API_ORIGIN + "/")).toBe(PRODUCTION_API_ORIGIN);
  });

  it.each([
    undefined, "", "http://api.ustal.site", legacy, "https://ustal.site",
    "https://api.ustal.site.evil.test", "https://evil.test/api.ustal.site",
    "https://api.ustal.site@evil.test", "https://user@api.ustal.site",
    "https://user:password@api.ustal.site", "https://api.ustal.site:444",
    "https://api.ustal.site/v1", "https://api.ustal.site/%2f",
    "https://api.ustal.site?next=https://evil.test", "https://api.ustal.site#fragment",
    "https://api.ustal.site.", "https://localhost", "https://127.0.0.1", "https://[::1]",
  ])("rejects an unapproved production destination: %s", (url) => {
    expect(() => productionApiUrl(url)).toThrow();
    if (url) {
      vi.stubEnv("APP_ENV", "production");
      vi.stubEnv("USTAL_API_URL", url);
      expect(() => configure({ config: structuredClone(base) })).toThrow();
    }
  });

  it("does not redirect or rewrite the transport used by an already installed legacy build", async () => {
    const fetchMock = vi.fn(async (_input: string) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ baseUrl: legacy, getAccessToken: () => null });
    await client.request("/health");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(legacy + "/health");
  });
});
