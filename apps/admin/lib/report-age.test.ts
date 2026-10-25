import { expect, it } from "vitest";
import { reportAge } from "./report-age";
const now = Date.parse("2026-10-24T00:00:00Z");
it("labels new reports and clamps future timestamps", () => {
  expect(reportAge(new Date(now), now)).toEqual({label: "менее часа", overdue: false});
  expect(reportAge(new Date(now + 3600000), now).overdue).toBe(false);
});
it("does not flag exactly 24 hours", () => {
  expect(reportAge(new Date(now - 86400000), now)).toEqual({label: "24 ч", overdue: false});
});
it("flags older than 24 hours including sub-hour excess", () => {
  expect(reportAge(new Date(now - 86400001), now).overdue).toBe(true);
  expect(reportAge(new Date(now - 48 * 3600000), now).label).toBe("48 ч");
});
it("uses timestamps independently of timezone offsets", () => {
  expect(reportAge("2026-10-23T10:00:00+10:00", now).overdue).toBe(false);
});
