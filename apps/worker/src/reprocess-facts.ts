import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { PROFILE_FACTS_PIPELINE_VERSION, PROFILE_FACTS_PROMPT_VERSION, profileFactsModel } from "@ustal/ai";
import { handleProfileFactsExtraction, type ProfileFactsResult } from "./handlers/profile-facts-extraction.js";

/**
 * Phase 1 profile_facts: (re)extract facts from stored raw inputs. Selects confirmed inputs that have no
 * SUCCEEDED extraction for the CURRENT pipeline/prompt/model version — i.e. never extracted, failed, or
 * extracted by an older version. Raw text is never modified. AI-only facts of an older version become
 * `replaced` (lineage replaces_fact_id); facts the owner confirmed/corrected/revoked keep their decision
 * (see handleProfileFactsExtraction). Messages withdrawn by the owner are skipped. Dry-run by default.
 */
export async function reprocessProfileFacts(filter: { sourceInputId?: string; userId?: string; all?: boolean }, apply = false) {
  if (!filter.sourceInputId && !filter.userId && !filter.all) throw new Error("A filter is required");
  const db = getDb();
  const inputs = await db.select({ id: schema.profileSourceInputs.id, userId: schema.profileSourceInputs.userId })
    .from(schema.profileSourceInputs)
    .where(and(
      eq(schema.profileSourceInputs.status, "confirmed"),
      isNull(schema.profileSourceInputs.revokedAt), // withdrawn messages are never re-extracted
      filter.sourceInputId ? eq(schema.profileSourceInputs.id, filter.sourceInputId) : undefined,
      filter.userId ? eq(schema.profileSourceInputs.userId, filter.userId) : undefined,
    ))
    .orderBy(asc(schema.profileSourceInputs.createdAt));
  const done = inputs.length ? await db.select({ sourceInputId: schema.profileFactExtractions.sourceInputId })
    .from(schema.profileFactExtractions)
    .where(and(
      inArray(schema.profileFactExtractions.sourceInputId, inputs.map((i) => i.id)),
      eq(schema.profileFactExtractions.status, "succeeded"),
      eq(schema.profileFactExtractions.pipelineVersion, PROFILE_FACTS_PIPELINE_VERSION),
      eq(schema.profileFactExtractions.promptVersion, PROFILE_FACTS_PROMPT_VERSION),
      eq(schema.profileFactExtractions.model, profileFactsModel()),
    )) : [];
  const skip = new Set(done.map((d) => d.sourceInputId));
  const todo = inputs.filter((i) => !skip.has(i.id));
  if (!apply) return { dryRun: true, confirmedInputs: inputs.length, toExtract: todo.length };
  const results: Record<string, number> = {};
  // Oldest first: statements are ordered by the user's message time anyway (resolveSlots).
  for (const i of todo) {
    const r: ProfileFactsResult = await handleProfileFactsExtraction({ id: randomUUID(), data: { userId: i.userId, sourceInputId: i.id } } as never);
    results[r.status] = (results[r.status] ?? 0) + 1;
  }
  return { dryRun: false, confirmedInputs: inputs.length, extracted: todo.length, results };
}
