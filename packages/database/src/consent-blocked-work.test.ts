import { describe, expect, it } from "vitest";
import { blockedWorkIntent, policyProbeDelaySeconds } from "./consent-blocked-work.js";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const input = { kind: "profile_extract" as const, sourceId: id, executionId: id, sourceVersionHash: "a".repeat(64),
  subjectUserIds: [other, id], purpose: "synthetic-purpose", policyId: id, policyHash: "b".repeat(64), recipientBinding: "c".repeat(64) };
describe("dormant blocked-work intent", () => {
  it("canonicalizes trusted subject sets and hashes every intent dimension", () => {
    const a = blockedWorkIntent(input);
    expect(blockedWorkIntent({ ...input, subjectUserIds: [id, other, id] }).logicalKey).toBe(a.logicalKey);
    for (const changed of [{ executionId: other }, { sourceVersionHash: "d".repeat(64) }, { sourceId: other }, { kind: "order_extract" as const },
      { kind: "profile_transcribe" as const }, { kind: "order_transcribe" as const },
      { policyHash: "e".repeat(64) }, { policyId: other }, { purpose: "another" }, { recipientBinding: "f".repeat(64) }, { subjectUserIds: [id] }])
      expect(blockedWorkIntent({ ...input, ...changed }).logicalKey).not.toBe(a.logicalKey);
  });
  it("rejects malformed or text-carrying intent fields; stores metadata only", () => {
    for (const change of [{ executionId: undefined }, { subjectUserIds: [] }, { sourceId: "https://audio.invalid/file" }, { sourceVersionHash: "source text" },
      { kind: "raw text" }, { purpose: "https://secret.invalid" }]) expect(() => blockedWorkIntent({ ...input, ...change } as any)).toThrow();
    expect(blockedWorkIntent({ ...input, sourceText: "NEVER STORED" } as any)).not.toHaveProperty("sourceText");
  });
  it("uses bounded outage probes without changing consent", () => {
    expect(policyProbeDelaySeconds(0)).toBe(5);
    expect(policyProbeDelaySeconds(1)).toBe(10);
    expect(policyProbeDelaySeconds(99)).toBe(900);
    expect(() => policyProbeDelaySeconds(-1)).toThrow();
  });
});
