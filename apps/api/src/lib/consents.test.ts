import { describe, expect, it } from "vitest";
import { disclosureHash } from "./consents.js";

describe("disclosure content fingerprint", () => {
  it("canonicalizes object order without flattening arrays, null, empty or Unicode values", () => {
    expect(disclosureHash({ b: ["provider", "purpose"], a: { text: "данные" } }))
      .toBe(disclosureHash({ a: { text: "данные" }, b: ["provider", "purpose"] }));
    expect(new Set([null, "", [], {}, ["a", "b"], ["b", "a"]].map(disclosureHash)).size).toBe(6);
    expect(disclosureHash({ recipients: ["A"] })).not.toBe(disclosureHash({ recipients: ["B"] }));
    expect(disclosureHash({ number: 1.5 })).not.toBe(disclosureHash({ number: 1 }));
    expect(disclosureHash({ value: false })).not.toBe(disclosureHash({ value: 0 }));
  });
  it("rejects non-JSON content instead of silently omitting evidence", () => {
    for (const value of [undefined, { text: undefined }, NaN, Infinity, new Date(), () => 1])
      expect(() => disclosureHash(value)).toThrow();
  });
});
