import { expect, it } from "vitest";
import { canDeleteOrder } from "./order-delete";

it("allows deleting orders without a selected executor", () => {
  for (const s of ["processing", "processing_failed", "moderation_hold", "published"] as const) {
    expect(canDeleteOrder(s)).toBe(true);
  }
});
it("forbids deleting orders in negotiation or finished", () => {
  for (const s of ["negotiating", "closed", "expired", "rejected", "cancelled"] as const) {
    expect(canDeleteOrder(s)).toBe(false);
  }
});
