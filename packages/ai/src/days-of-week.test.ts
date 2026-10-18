import { describe, expect, it } from "vitest";
import { resolveDaysOfWeek } from "./days-of-week.js";

/**
 * Дни недели (2026-10-17, live FAIL «Не работаю по воскресеньям» → [6]): модель возвращает дни и явный знак
 * daysMode; сервер детерминированно приводит к контракту системы daysOfWeek = РАЗРЕШЁННЫЕ дни.
 */
describe("resolveDaysOfWeek: daysMode → allowed days", () => {
  it("excluded single day → complement («Не работаю по воскресеньям» → пн–сб)", () => {
    expect(resolveDaysOfWeek([6], "excluded")).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("excluded several days → complement («Не работаю в субботу и воскресенье» → пн–пт)", () => {
    expect(resolveDaysOfWeek([5, 6], "excluded")).toEqual([0, 1, 2, 3, 4]);
  });
  it("allowed days as is: weekdays; «только по воскресеньям» → [6]", () => {
    expect(resolveDaysOfWeek([0, 1, 2, 3, 4], "allowed")).toEqual([0, 1, 2, 3, 4]);
    expect(resolveDaysOfWeek([6], "allowed")).toEqual([6]);
  });
  it("no mode → no day restriction even if days were listed («Могу работать по воскресеньям»)", () => {
    expect(resolveDaysOfWeek([6], null)).toBeNull();
    expect(resolveDaysOfWeek(null, null)).toBeNull();
  });
  it("duplicates and order are canonicalized", () => {
    expect(resolveDaysOfWeek([4, 0, 4, 2], "allowed")).toEqual([0, 2, 4]);
    expect(resolveDaysOfWeek([6, 6, 5], "excluded")).toEqual([0, 1, 2, 3, 4]);
  });
  it("edge cases: empty lists and all 7 days are not a day restriction; never silently [] allowed", () => {
    expect(resolveDaysOfWeek([], "excluded")).toBeNull();
    expect(resolveDaysOfWeek([], "allowed")).toBeNull();
    expect(resolveDaysOfWeek(null, "excluded")).toBeNull();
    expect(resolveDaysOfWeek([0, 1, 2, 3, 4, 5, 6], "allowed")).toBeNull();
    expect(resolveDaysOfWeek([0, 1, 2, 3, 4, 5, 6], "excluded")).toBeNull();
  });
  it("invalid days or mode are rejected (the structured call is repaired), never passed on", () => {
    expect(() => resolveDaysOfWeek([7], "excluded")).toThrow();
    expect(() => resolveDaysOfWeek([-1], "allowed")).toThrow();
    expect(() => resolveDaysOfWeek([1.5], "allowed")).toThrow();
    expect(() => resolveDaysOfWeek([1], "forbidden" as never)).toThrow();
  });
});
