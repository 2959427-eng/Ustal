import { expect, it } from "vitest";
import { countNotificationBadges, unreadNotificationIdsForOrder, type BadgeNotification } from "./notification-badges";

const n = (id: string, type: string, orderId: string, read = false): BadgeNotification =>
  ({ id, type, payload: { orderId }, readAt: read ? "2026-09-30T00:00:00Z" : null });

it("counts only unread notifications, split by role; not the number of orders", () => {
  const items = [
    n("1", "new_response", "A"), n("2", "new_response", "A"), n("3", "executor_reported_issue", "B"),
    n("4", "new_response", "C", true),
    n("5", "selected", "D"), n("6", "contact_unlocked", "D", true),
    n("7", "some_future_type", "E"),
  ];
  expect(countNotificationBadges(items)).toEqual({ orders: 3, opportunities: 1 });
});

it("no unread notifications -> no badges", () => {
  expect(countNotificationBadges([])).toEqual({ orders: 0, opportunities: 0 });
  expect(countNotificationBadges([n("1", "new_response", "A", true)])).toEqual({ orders: 0, opportunities: 0 });
});

it("opening an order marks only that order's unread notifications", () => {
  const items = [n("1", "new_response", "A"), n("2", "selected", "A"), n("3", "new_response", "A", true), n("4", "new_response", "B")];
  expect(unreadNotificationIdsForOrder(items, "A")).toEqual(["1", "2"]);
  expect(unreadNotificationIdsForOrder(items, "Z")).toEqual([]);
});
