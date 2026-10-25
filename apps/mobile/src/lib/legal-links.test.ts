import { describe, expect, it } from "vitest";
import { legalLinks, legalUrl } from "./legal-links";
describe("public USTAL legal links", () => {
  it("opens all five documents on the configured API origin without tokens or nested paths", () => {
    for (const [page] of legalLinks) expect(legalUrl("https://api.104-171-139-154.sslip.io/path?token=ignored", page)).toBe(`https://api.104-171-139-154.sslip.io/${page}`);
  });
  it("rejects insecure links, embedded credentials and arbitrary destinations", () => {
    for (const origin of ["http://localhost", "javascript:alert(1)", "https://user:password@ustal.test"]) expect(() => legalUrl(origin, "privacy")).toThrow();
    expect(() => legalUrl("https://ustal.test", "elsewhere" as "privacy")).toThrow();
  });
});
