import { describe, expect, it } from "vitest";
import { legalLinks, legalUrl } from "./legal-links";
describe("public USTAL legal links", () => {
  it.each(["https://api.ustal.site", "https://api.104-171-139-154.sslip.io"])("opens documents on configured origin %s without tokens or nested paths", (origin) => {
    for (const [page] of legalLinks) expect(legalUrl(`${origin}/path?token=ignored`, page)).toBe(`${origin}/${page}`);
  });
  it("rejects insecure links, embedded credentials and arbitrary destinations", () => {
    for (const origin of ["http://localhost", "javascript:alert(1)", "https://user:password@ustal.test"]) expect(() => legalUrl(origin, "privacy")).toThrow();
    expect(() => legalUrl("https://ustal.test", "elsewhere" as "privacy")).toThrow();
  });
});
