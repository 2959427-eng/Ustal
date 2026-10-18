import { normalizeProfileItemIdentity } from "@ustal/domain";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@ustal/database";
import type { ProfileFactLike } from "./profile-negatives.js";
import type { persistDocument } from "./semantic.js";

type Tx = Parameters<typeof persistDocument>[0];

/** Identity does not erase roles, limits or capacities. Nor does it equate
 * different names just because they share an ontology node or an embedding.
 */
export function deduplicateProfileResourceFacts<T extends ProfileFactLike>(facts: T[], sourceText: string): T[] {
  const out: T[] = [];
  const groups = new Map<string, number[]>();
  const at = (f: T) => f.evidence ? sourceText.lastIndexOf(f.evidence) : -1;
  for (const f of facts) {
    const identity = normalizeProfileItemIdentity(f.phrase);
    if (f.kind !== "resource" || !identity) { out.push(f); continue; }
    const capacity = f.resourceCapacity;
    const constrained = (f.constraintType != null && f.constraintType !== "none") || f.startHour != null || f.endHour != null || !!f.daysOfWeek?.length;
    const key = JSON.stringify([identity,
      !f.resourceRole || f.resourceRole === "none" ? "available" : f.resourceRole,
      f.constraintType ?? "none", constrained ? f.constraintScope ?? "fact" : null,
      capacity?.value ?? null, capacity?.unit ?? null, capacity?.kind ?? null,
      f.startHour ?? null, f.endHour ?? null, f.daysOfWeek?.length ? [...f.daysOfWeek].sort() : null]);
    const indexes = groups.get(key) ?? [];
    // Conflicting established ontology bindings are not evidence of identity.
    const index = indexes.find((i) => !out[i]!.nodeIds.length || !f.nodeIds.length ||
      JSON.stringify([...out[i]!.nodeIds].sort()) === JSON.stringify([...f.nodeIds].sort()));
    if (index === undefined) {
      indexes.push(out.length); groups.set(key, indexes); out.push(f); continue;
    }
    const previous = out[index]!;
    const winner = at(f) >= at(previous) ? f : previous;
    const other = winner === f ? previous : f;
    // Retain an established binding if the equivalent new spelling is unmapped.
    out[index] = winner.nodeIds.length || !other.nodeIds.length ? winner : { ...winner, nodeIds: other.nodeIds };
  }
  return out;
}

/** Carry-forward can introduce duplicates after initial document persistence.
 * Clean only this new profile's resource facts/rows, inside its existing lock.
 */
export async function deduplicatePersistedProfileResources(tx: Tx, profileId: string, documentId: string, sourceText: string) {
  const facts = await tx.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, documentId));
  const retained = deduplicateProfileResourceFacts(facts, sourceText);
  const ids = new Set(retained.map((f) => f.id));
  const duplicates = facts.filter((f) => !ids.has(f.id)).map((f) => f.id);
  if (duplicates.length) await tx.delete(schema.matchingFacts).where(inArray(schema.matchingFacts.id, duplicates));
  const originals = new Map(facts.map((f) => [f.id, f]));
  for (const f of retained) {
    const original = originals.get(f.id)!;
    if (JSON.stringify(original.nodeIds) !== JSON.stringify(f.nodeIds))
      await tx.update(schema.matchingFacts).set({ nodeIds: f.nodeIds }).where(eq(schema.matchingFacts.id, f.id));
  }
  const resources = await tx.select().from(schema.userResources).where(eq(schema.userResources.capabilityProfileId, profileId));
  const seen = new Set<string>(), duplicateRows: string[] = [];
  for (const r of resources) {
    const key = JSON.stringify([normalizeProfileItemIdentity(r.label), r.ontologyNodeId, r.resourceType, r.attributes]);
    if (seen.has(key)) duplicateRows.push(r.id);
    else seen.add(key);
  }
  if (duplicateRows.length) await tx.delete(schema.userResources).where(inArray(schema.userResources.id, duplicateRows));
}
