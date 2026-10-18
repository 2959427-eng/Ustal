import { describe, expect, it } from "vitest";
import { attributesChange, canonicalUnit, mergeAttributes, normalizeAttributes, normalizeLabel } from "./profile-item-attributes.js";

describe("profile item attributes (2026-10-15)", () => {
  it("canonical keys and units; numbers from «1,5»; the same meaning gives one key", () => {
    expect(normalizeAttributes([
      { key: "seats", value: "6", unit: "мест" },
      { key: "Load capacity", value: "1,5", unit: "тонны" },
      { key: "height", value: 5, unit: "метров" },
      { key: "manufacturer", value: "Sony", unit: "шт" },
      { key: "payload", value: 2, unit: "т" },
    ])).toEqual([
      { key: "passenger_capacity", value: 6, unit: "pcs" },
      { key: "payload", value: 2, unit: "t" },
      { key: "height", value: 5, unit: "m" },
      { key: "brand", value: "Sony", unit: null },
    ]);
    expect(canonicalUnit("кг")).toBe("kg");
    expect(canonicalUnit("л")).toBe("л");
  });
  it("drops malformed entries; free snake_case keys stay", () => {
    expect(normalizeAttributes([{ key: "", value: 1, unit: null }, { key: "1x", value: 1, unit: null }, { key: "volume_l", value: "", unit: null },
      { key: "bucket volume", value: 0.8, unit: "м3" }, null, "x"])).toEqual([{ key: "bucket_volume", value: 0.8, unit: "м3" }]);
    expect(normalizeAttributes(undefined)).toEqual([]);
  });
  it("merge replaces by key; change detection", () => {
    const prior = [{ key: "passenger_capacity", value: 6, unit: "pcs" }];
    expect(attributesChange(prior, [{ key: "passenger_capacity", value: 6, unit: "pcs" }])).toBe(false);
    expect(attributesChange(prior, [{ key: "passenger_capacity", value: 8, unit: "pcs" }])).toBe(true);
    expect(attributesChange(prior, [])).toBe(false);
    expect(mergeAttributes(prior, [{ key: "passenger_capacity", value: 8, unit: "pcs" }, { key: "brand", value: "ПАЗ", unit: null }]))
      .toEqual([{ key: "passenger_capacity", value: 8, unit: "pcs" }, { key: "brand", value: "ПАЗ", unit: null }]);
  });
  it("label: trimmed, capitalized, trailing punctuation removed; meaning untouched", () => {
    expect(normalizeLabel("  перевозка   вещей. ")).toBe("Перевозка вещей");
    expect(normalizeLabel("")).toBeNull();
    expect(normalizeLabel(null)).toBeNull();
  });
});
