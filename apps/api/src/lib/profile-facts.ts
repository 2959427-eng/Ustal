import { loadEnv } from "@ustal/config";
import { JOB_TYPES } from "@ustal/queue";

/**
 * Phase 1 profile_facts (SHADOW): enqueue the separate per-input fact extraction. Best effort: the
 * profile input is already stored and the capability-profile job already queued, so a failure here must
 * not change the API response (missing extractions are picked up by reprocess-facts-cli.ts).
 */
export async function enqueueProfileFacts(
  boss: { send: (name: string, data: object) => Promise<unknown> },
  data: { userId: string; sourceInputId: string },
): Promise<boolean> {
  if (loadEnv().PROFILE_FACTS_EXTRACTION !== "enabled") return false;
  try {
    await boss.send(JOB_TYPES.PROFILE_FACTS_EXTRACTION, data);
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: "profile_facts_enqueue_failed", sourceInputId: data.sourceInputId,
      error: error instanceof Error ? error.name : "unknown" }));
    return false;
  }
}
