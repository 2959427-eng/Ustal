import { describe, expect, it } from "vitest";
import { deliveryWaveWindowMs, MAX_ACTIVE_RESPONSES, MAX_DELIVERY_WAVES, nextWaveDue, responsesOpen } from "./order-delivery.js";

const H = 3600_000;
const now = new Date("2026-10-15T12:00:00Z");
const base = { status: "published", deliveryWave: 1, deliveredWave: 1, deliveryWaveAt: null, publishedAt: new Date(now.getTime() - 7 * H), deliveryExhaustedAt: null, responsesClosedAt: null, desiredAt: null };

describe("order delivery waves (2026-10-15)", () => {
  it("window: urgent (≤24 h) 1 h, otherwise 6 h", () => {
    expect(deliveryWaveWindowMs(null, now)).toBe(6 * H);
    expect(deliveryWaveWindowMs(new Date(now.getTime() + 5 * H), now)).toBe(H);
    expect(deliveryWaveWindowMs(new Date(now.getTime() + 3 * 24 * H), now)).toBe(6 * H);
  });
  it("next wave only while responses are below the limit and nothing stops delivery", () => {
    expect(nextWaveDue(base, 2, now)).toBe(true);
    expect(nextWaveDue(base, MAX_ACTIVE_RESPONSES, now)).toBe(false);
    expect(nextWaveDue({ ...base, publishedAt: new Date(now.getTime() - 5 * H) }, 0, now)).toBe(false);
    expect(nextWaveDue({ ...base, deliveryWaveAt: new Date(now.getTime() - H) }, 0, now)).toBe(false);
    expect(nextWaveDue({ ...base, responsesClosedAt: now }, 0, now)).toBe(false);
    expect(nextWaveDue({ ...base, deliveryExhaustedAt: now }, 0, now)).toBe(false);
    expect(nextWaveDue({ ...base, status: "negotiating" }, 0, now)).toBe(false);
    expect(nextWaveDue({ ...base, deliveryWave: MAX_DELIVERY_WAVES, deliveredWave: MAX_DELIVERY_WAVES }, 0, now)).toBe(false);
    expect(nextWaveDue({ ...base, deliveredWave: 0 }, 0, now)).toBe(false);
    expect(nextWaveDue({ ...base, desiredAt: new Date(now.getTime() - H) }, 0, now)).toBe(false);
  });
  it("responses open: below the limit and not closed by the author", () => {
    expect(responsesOpen({ responsesClosedAt: null }, MAX_ACTIVE_RESPONSES - 1)).toBe(true);
    expect(responsesOpen({ responsesClosedAt: null }, MAX_ACTIVE_RESPONSES)).toBe(false);
    expect(responsesOpen({ responsesClosedAt: now }, 0)).toBe(false);
  });
});
