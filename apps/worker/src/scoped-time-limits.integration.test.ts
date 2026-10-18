import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { prepareDocument } from "./semantic.js";
import { resolveProfileNegatives, planNegativeOverrides } from "./profile-negatives.js";
assertLocalTestDatabase();
afterAll(async () => { await getSql().end(); });

const TEXT = "Занимаюсь доставкой. Не занимаюсь доставкой после 22:00.";
const fact = (over: Record<string, unknown>) => ({
  subjectType: "unspecified", canonicalKeys: [], confidence: 0.95, mandatory: false, constraintType: "none", constraintScope: "whole_task",
  resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null }, startHour: null, endHour: null, daysOfWeek: null, ...over,
});
async function prepare(limit: Record<string, unknown>) {
  const spy = vi.spyOn(mockProviders.extraction, "normalizeMatching").mockResolvedValue({
    data: { facts: [
      fact({ kind: "capability", phrase: "доставка", evidence: "Занимаюсь доставкой.", canonicalKeys: ["delivery"] }),
      fact({ evidence: "Не занимаюсь доставкой после 22:00.", endHour: 22, ...limit }),
    ] }, provider: "mock", model: "mock", tokensInput: 0, tokensOutput: 0, latencyMs: 0,
  } as never);
  try { return (await prepareDocument("profile", TEXT, {}, randomUUID())).facts; } finally { spy.mockRestore(); }
}
const keys = async (ids: string[]) => ids.length ? (await getDb().select({ k: schema.ontologyNodes.canonicalKey }).from(schema.ontologyNodes).where(inArray(schema.ontologyNodes.id, ids))).map((r) => r.k) : [];

it("a time-bounded refusal (model typed it as exclude) becomes an activity-scoped time limit, not a refusal", async () => {
  const facts = await prepare({ kind: "exclude", phrase: "доставка", constraintType: "availability", canonicalKeys: ["delivery"] });
  const skill = facts.find((f) => f.kind === "capability")!;
  const limit = facts.find((f) => f.endHour === 22)!;
  expect(limit).toMatchObject({ kind: "availability", constraintType: "availability", constraintScope: "fact", endHour: 22 });
  expect(await keys(limit.nodeIds)).toEqual(["delivery"]);
  // The delivery skill is not removed by the time limit.
  expect(await keys(skill.nodeIds)).toEqual(["delivery"]);
});
it("the scoped availability form is kept as the model returned it", async () => {
  const facts = await prepare({ kind: "availability", phrase: "доставка", constraintType: "availability", constraintScope: "fact", canonicalKeys: ["delivery"] });
  expect(facts.find((f) => f.endHour === 22)).toMatchObject({ kind: "availability", constraintScope: "fact" });
  expect(facts.filter((f) => f.kind === "capability")).toHaveLength(1);
});
it("a global limit stays global (whole_task, no node)", async () => {
  const facts = await prepare({ kind: "availability", phrase: "после 22:00 не работаю", constraintType: "availability", constraintScope: "whole_task" });
  expect(facts.find((f) => f.endHour === 22)).toMatchObject({ kind: "availability", constraintScope: "whole_task", nodeIds: [] });
});
it("negative overrides: a time-bounded refusal never cancels the skill (stored legacy form)", () => {
  const e = [1, 0, 0];
  const skill = { kind: "capability", phrase: "доставка", evidence: "Занимаюсь доставкой.", nodeIds: ["d"], embedding: e, constraintType: "none" };
  const legacy = { kind: "exclude", phrase: "доставка", evidence: "Не занимаюсь доставкой после 22:00.", nodeIds: ["d"], embedding: e, constraintType: "availability", endHour: 22 };
  expect(resolveProfileNegatives([skill, legacy] as never, TEXT)).toContain(skill);
  expect(planNegativeOverrides([legacy] as never, [skill] as never).excludedNodeIds.size).toBe(0);
  // An explicit revoke of the skill still cancels it; a plain restriction does not.
  const refusal = { ...legacy, constraintType: "exclusion", endHour: null };
  expect(planNegativeOverrides([{ ...refusal, refusalIntent: "revoke" }] as never, [skill] as never).excludedNodeIds.has("d")).toBe(true);
  expect(planNegativeOverrides([refusal] as never, [skill] as never).excludedNodeIds.size).toBe(0);
});
it("a time-limited refusal keeps the activity node even when the phrase is the whole sentence", async () => {
  const facts = await prepare({ kind: "exclude", phrase: "Не занимаюсь доставкой после 22:00", constraintType: "availability", constraintScope: "fact", canonicalKeys: ["delivery"] });
  const limit = facts.find((f) => f.endHour === 22)!;
  expect(limit).toMatchObject({ kind: "availability", constraintScope: "fact" });
  expect(await keys(limit.nodeIds)).toEqual(["delivery"]);
});
