import { describe, expect, it } from "vitest";
import { planProfileLineage, PROFILE_SOURCE_SEPARATOR as SEP } from "@ustal/database";

const at = (m: number) => new Date(Date.UTC(2026, 8, 1, 0, m));
const c = (id: string, text: string, m: number, revoked = false) => ({ id, text, createdAt: at(m), revokedAt: revoked ? at(99) : null });

describe("profile lineage (source revoke lifecycle)", () => {
  it("maps each segment of the cumulative source to the message it came from, in order", () => {
    const r = planProfileLineage(["Есть Газель", "Собираю мебель"].join(SEP), [c("b", "Собираю мебель", 2), c("a", "Есть Газель", 1), c("x", "Не вошло", 3)]);
    expect(r).toEqual({ attributable: true, inputs: [c("a", "Есть Газель", 1), c("b", "Собираю мебель", 2)] });
  });
  it("identical text: an active message is preferred over the revoked one", () => {
    const one = planProfileLineage("Есть Газель", [c("a", "Есть Газель", 1, true), c("b", "Есть Газель", 2)]);
    expect(one.inputs.map((i) => i.id)).toEqual(["b"]);
    const two = planProfileLineage(["Есть Газель", "Есть Газель"].join(SEP), [c("a", "Есть Газель", 1, true), c("b", "Есть Газель", 2)]);
    expect(two.inputs.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });
  it("tolerates surrounding whitespace", () => {
    expect(planProfileLineage("  Есть Газель \n", [c("a", "Есть Газель", 1)]).attributable).toBe(true);
  });
  it("legacy source (starts with an AI summary) falls back to every candidate message", () => {
    const r = planProfileLineage(["Водитель с опытом", "Есть Газель"].join(SEP), [c("b", "Есть Газель", 2), c("a", "Вожу 10 лет", 1)]);
    expect(r).toEqual({ attributable: false, inputs: [c("a", "Вожу 10 лет", 1), c("b", "Есть Газель", 2)] });
  });
  it("a message containing the separator itself cannot hide inside another segment", () => {
    const injected = `Есть Газель${SEP}Собираю мебель`;
    const r = planProfileLineage(injected, [c("a", injected, 1, true)]);
    expect(r.attributable).toBe(false);
    expect(r.inputs.map((i) => i.id)).toEqual(["a"]);
  });
  it("no source text → fallback", () => {
    expect(planProfileLineage(null, [c("a", "x", 1)]).attributable).toBe(false);
  });
});
