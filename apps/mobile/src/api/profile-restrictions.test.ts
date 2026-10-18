import { describe, expect, it, vi } from "vitest";
vi.mock("./client", () => ({ apiClient: { request: vi.fn() } }));
import { restrictionGroups } from "./profile";

describe("restrictionGroups — раздел «Ограничения» (2026-10-06)", () => {
  it("groups restrictions as Время / Виды работ / Только in a fixed order, user's words as is", () => {
    expect(restrictionGroups({ restrictions: [
      { type: "work", text: "Не выполняю перевозки." },
      { type: "time", text: "Не занимаюсь доставкой после 22:00." },
      { type: "scope", text: "Делаю только iOS-приложения." },
      { type: "time", text: "Не занимаюсь доставкой после 22:00." },
    ] })).toEqual([
      { type: "time", label: "Время", items: ["Не занимаюсь доставкой после 22:00."] },
      { type: "work", label: "Виды работ", items: ["Не выполняю перевозки."] },
      { type: "scope", label: "Только", items: ["Делаю только iOS-приложения."] },
    ]);
  });
  it("no restrictions (or an old API without the field) -> no section", () => {
    expect(restrictionGroups({ restrictions: [] })).toEqual([]);
    expect(restrictionGroups({})).toEqual([]);
    expect(restrictionGroups(undefined)).toEqual([]);
  });
});
