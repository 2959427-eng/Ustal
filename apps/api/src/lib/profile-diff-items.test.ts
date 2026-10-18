import { describe, expect, it } from "vitest";
import { pickUnmappedFacts, withItemAttributes } from "./profile-diff.js";

// Пункты профиля с подписью и характеристиками (2026-10-15).
describe("profile items: label and attributes in GET /profile", () => {
  const bus = { kind: "resource", phrase: "шестиместный автобус", label: "Автобус", attributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }], nodeIds: [], resourceRole: "available", constraintType: "none" };
  it("unmapped items show the label (not the raw phrase) and resource attributes", () => {
    expect(pickUnmappedFacts([bus, { kind: "capability", phrase: "могу перевозить людей", label: "Перевозка людей", nodeIds: [] },
      { kind: "capability", phrase: "вайбкодер", nodeIds: [] }])).toEqual([
      { kind: "resource", phrase: "Автобус", itemAttributes: [{ key: "passenger_capacity", value: 6, unit: "pcs" }] },
      { kind: "capability", phrase: "Перевозка людей" },
      { kind: "capability", phrase: "вайбкодер" },
    ]);
  });
  it("resource rows get attributes of the fact with the same node and label; a sold resource gives none", () => {
    const facts = [
      { kind: "resource", phrase: "газель 1,5 т", label: "Газель", attributes: [{ key: "payload", value: 1.5, unit: "t" }], nodeIds: ["van"], resourceRole: "available" },
      { kind: "resource", phrase: "машина", label: "Машина", attributes: [], nodeIds: ["car"], resourceRole: "available" },
      { kind: "resource", phrase: "грузовая машина", label: "Грузовая машина", attributes: [{ key: "payload", value: 5, unit: "t" }], nodeIds: ["car"], resourceRole: "available" },
      { kind: "resource", phrase: "дрель", label: "Дрель", attributes: [{ key: "brand", value: "Bosch", unit: null }], nodeIds: ["drill"], resourceRole: "missing" },
    ];
    const rows = [{ ontologyNodeId: "van", label: "Газель" }, { ontologyNodeId: "car", label: "Машина" }, { ontologyNodeId: "car", label: "Грузовая машина" }, { ontologyNodeId: "drill", label: "Дрель" }];
    expect(withItemAttributes(rows, facts).map((r) => [r.label, r.itemAttributes])).toEqual([
      ["Газель", [{ key: "payload", value: 1.5, unit: "t" }]], ["Машина", []], ["Грузовая машина", [{ key: "payload", value: 5, unit: "t" }]], ["Дрель", []]]);
  });
});
