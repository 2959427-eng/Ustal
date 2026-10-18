import { expect, it } from "vitest";
import { responseStatusLabel } from "./response-status";
it("a cancelled order is never described as choosing another executor", () => {
  expect(responseStatusLabel("not_selected", "cancelled", null)).toBe("Заказ отменён");
  expect(responseStatusLabel("not_selected", "cancelled", "cancelled")).toBe("Заказ отменён");
});
it("cancelling one negotiation does not claim cancellation of a live order", () => {
  expect(responseStatusLabel("not_selected", "published", "cancelled")).toBe("Переговоры отменены");
  expect(responseStatusLabel("active", "negotiating", "selected")).toBe("Ожидает решения");
});
it("withdrawal and normal non-selection retain distinct meanings", () => {
  expect(responseStatusLabel("withdrawn", "published", "cancelled")).toBe("Отозван");
  expect(responseStatusLabel("not_selected", "closed", null)).toBe("Не выбран");
  expect(responseStatusLabel("active", "published", "cancelled")).toBe("Ожидает решения");
});
