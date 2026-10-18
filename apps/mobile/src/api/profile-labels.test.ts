import { describe, expect, it, vi } from "vitest";
vi.mock("./client", () => ({ apiClient: { request: vi.fn() } }));
import { formatItemAttribute, recognizedLabels } from "./profile";

describe("recognizedLabels (2026-10-05)", () => {
  it("puts resources without ontology node under resources, skills under capabilities", () => {
    const out = recognizedLabels({
      capabilities: [{ label: "уборка" }] as never,
      resources: [{ label: "есть машина" }] as never,
      unmapped: [
        { kind: "resource", phrase: "есть самолёт" },
        { kind: "resource", phrase: "есть кофемашина" },
        { kind: "capability", phrase: "вайбкодер" },
      ],
    });
    expect(out).toEqual({ capabilities: ["уборка", "вайбкодер"], resources: ["есть машина", "есть самолёт", "есть кофемашина"] });
  });
  it("shows resource attributes next to the label (2026-10-15): «Автобус · 6 мест», «Газель · 1,5 т»", () => {
    const out = recognizedLabels({
      capabilities: [{ label: "Перевозка вещей" }] as never,
      resources: [{ label: "Газель", itemAttributes: [{ key: "payload", value: 1.5, unit: "t" }] }, { label: "Машина" }] as never,
      unmapped: [
        { kind: "resource", phrase: "Автобус", itemAttributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] },
        { kind: "resource", phrase: "Лестница", itemAttributes: [{ key: "height", value: 5, unit: "m" }] },
        { kind: "resource", phrase: "Камера", itemAttributes: [{ key: "brand", value: "Sony", unit: null }] },
        { kind: "capability", phrase: "Перевозка людей" },
      ],
    });
    expect(out).toEqual({ capabilities: ["Перевозка вещей", "Перевозка людей"],
      resources: ["Газель · 1,5 т", "Машина", "Автобус · 6 мест", "Лестница · 5 м", "Камера · Sony"] });
  });
  it("formats counts and units", () => {
    expect(formatItemAttribute({ key: "passenger_capacity", value: 1, unit: "pcs" })).toBe("1 место");
    expect(formatItemAttribute({ key: "passenger_capacity", value: 3, unit: "pcs" })).toBe("3 места");
    expect(formatItemAttribute({ key: "passenger_capacity", value: 12, unit: "pcs" })).toBe("12 мест");
    expect(formatItemAttribute({ key: "payload", value: 500, unit: "kg" })).toBe("500 кг");
    expect(formatItemAttribute({ key: "volume", value: 0.8, unit: "м3" })).toBe("0,8 м3");
  });
});
