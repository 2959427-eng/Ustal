/** Test assertion helpers only; no profile mutation, production imports or DB. */
import type { ExpectedState, Scenario, StepFixture } from "./fixtures.js";
export interface ObservedState {
  /** Preserve multiplicity: adapters MUST NOT use Set/dedup on these arrays. */
  skills: string[]; resources: string[]; workRestrictions: string[];
  timeRestrictions: { scope: "global" | "activity"; endHour: number | null; label: string }[];
  revokedSkills: string[]; missingResources: string[];
  /** Captured by calling the real evaluator/worker in the future adapter. */
  order23?: { rejected: boolean; reason: string };
}
export function stateViolations(actual: ObservedState, expected: ExpectedState): string[] {
  const errors: string[] = [];
  for (const field of ["skills", "resources", "workRestrictions", "revokedSkills", "missingResources"] as const) {
    const got = [...actual[field]].sort(), want = [...expected[field]].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) errors.push(`${field}: expected ${JSON.stringify(want)}, actual ${JSON.stringify(got)}`);
  }
  const hours = actual.timeRestrictions.filter((r) => r.scope === "global").map((r) => r.endHour).sort();
  if (JSON.stringify(hours) !== JSON.stringify([...expected.globalEndHours].sort())) errors.push(`time: expected ${JSON.stringify(expected.globalEndHours)}, actual ${JSON.stringify(hours)}`);
  if (actual.timeRestrictions.some((r) => r.scope === "activity")) errors.push("unexpected activity-scoped time window");
  for (const hour of expected.globalEndHours) {
    if (!actual.timeRestrictions.some((r) => r.endHour === hour && r.label.includes(`${hour}:00`))) errors.push(`display does not match grounded endHour=${hour}`);
  }
  if (expected.order23 !== "not_applicable") {
    if (!actual.order23) errors.push("23:00 order probe missing");
    else if (expected.order23 === "blocked" && (!actual.order23.rejected || actual.order23.reason !== "outside_availability"))
      errors.push(`23:00 must reject outside_availability, actual ${JSON.stringify(actual.order23)}`);
    else if (expected.order23 === "allowed" && actual.order23.rejected)
      errors.push(`23:00 digging order must pass after time lift, actual ${JSON.stringify(actual.order23)}`);
  }
  return errors;
}
/** Binding is the ONLY future integration seam. No default implementation:
 * missing incremental code must never fall back to a toy profile reducer.
 */
export interface IncrementalAdapter {
  reset(): Promise<void>;
  apply(step: StepFixture): Promise<ObservedState>;
}
export async function exerciseScenario(adapter: IncrementalAdapter, scenario: Scenario) {
  await adapter.reset();
  const transcript: { step: string; message: string; expected: ExpectedState; actual: ObservedState; violations: string[] }[] = [];
  for (const step of scenario.steps) {
    const actual = await adapter.apply(step);
    transcript.push({ step: step.id, message: step.message, expected: step.expected, actual, violations: stateViolations(actual, step.expected) });
  }
  // Accumulate every step, do not stop on the first failure in the long scenario.
  return { id: scenario.id, passed: transcript.every((s) => !s.violations.length), transcript };
}
/** Orthogonal deterministic fixture embeddings, no model calls or thresholds. */
export function fixtureEmbedding(axis: number): number[] {
  if (!Number.isInteger(axis) || axis < 0 || axis >= 1536) throw new Error("Fixture embedding axis must be 0..1535");
  return Array.from({ length: 1536 }, (_, i) => i === axis ? 1 : 0);
}
