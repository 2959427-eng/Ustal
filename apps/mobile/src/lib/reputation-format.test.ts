import { expect, it } from "vitest";
import { customerLine, executorLine } from "./reputation-format";

it("formats executor reputation with a star rating, its count, and outcome counts", () => {
  expect(executorLine({ rating: 4.5, ratingCount: 12, completed: 12, notCompleted: 1 })).toBe("★ 4,5 (12) · выполнено 12 · не выполнено 1");
  expect(executorLine({ rating: null, ratingCount: 0, completed: 0, notCompleted: 0 })).toBe("★ — (0) · выполнено 0 · не выполнено 0");
});

it("formats customer reputation with its own independent star rating, count, and order history", () => {
  expect(customerLine({ rating: 4.8, ratingCount: 3, total: 5, completed: 3, cancelled: 0 })).toBe("★ 4,8 (3) · всего 5 · завершено 3 · отменено 0");
  expect(customerLine({ rating: null, ratingCount: 0, total: 0, completed: 0, cancelled: 0 })).toBe("★ — (0) · всего 0 · завершено 0 · отменено 0");
});
