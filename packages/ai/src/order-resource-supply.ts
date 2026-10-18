import type { SemanticFact } from "@ustal/validation";

/** A resource supplied at the task is not an executor ownership requirement. */
export function resolveOrderResourceSupply(
  kind: "profile" | "order", fact: SemanticFact, supply: unknown,
): SemanticFact {
  if (kind !== "order" || fact.kind !== "resource") {
    if (supply !== null) throw new Error("orderResourceSupply must be null outside order resources");
    return fact;
  }
  if (supply !== "provided" && supply !== "executor" && supply !== "unspecified")
    throw new Error("orderResourceSupply must identify provided, executor or unspecified supply");
  return supply === "provided" ? { ...fact, mandatory: false } : fact;
}
