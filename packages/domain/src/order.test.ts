import { describe, expect, it } from "vitest";
import { assertOrderTransition, canTransitionOrder, type OrderStatus } from "./order.js";

const ALL_STATUSES: OrderStatus[] = [
  "draft",
  "processing",
  "moderation_hold",
  "published",
  "negotiating",
  "closed",
  "expired",
  "cancelled",
  "rejected",
];

describe("order state machine", () => {
  it("allows the documented happy path draft -> processing -> published -> negotiating -> closed", () => {
    expect(canTransitionOrder("draft", "processing")).toBe(true);
    expect(canTransitionOrder("processing", "published")).toBe(true);
    expect(canTransitionOrder("published", "negotiating")).toBe(true);
    expect(canTransitionOrder("negotiating", "closed")).toBe(true);
  });

  it("allows an author to cancel while stuck in processing or moderation_hold (Фаза 3)", () => {
    expect(canTransitionOrder("processing", "cancelled")).toBe(true);
    expect(canTransitionOrder("moderation_hold", "cancelled")).toBe(true);
  });

  it("never allows skipping straight to rejected without moderation_hold", () => {
    expect(canTransitionOrder("processing", "rejected")).toBe(false);
    expect(canTransitionOrder("draft", "rejected")).toBe(false);
  });

  it("terminal statuses have no outgoing transitions", () => {
    for (const terminal of ["closed", "expired", "cancelled", "rejected"] as const) {
      for (const to of ALL_STATUSES) {
        expect(canTransitionOrder(terminal, to)).toBe(false);
      }
    }
  });

  it("assertOrderTransition throws on an invalid transition and is silent on a valid one", () => {
    expect(() => assertOrderTransition("draft", "published")).toThrow();
    expect(() => assertOrderTransition("draft", "processing")).not.toThrow();
  });
});
