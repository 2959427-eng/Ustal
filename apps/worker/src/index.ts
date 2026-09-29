import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv } from "@ustal/config";
import { getBoss, JOB_TYPES } from "@ustal/queue";
import { handleProfileTranscribe } from "./handlers/profile-transcribe.js";
import { handleProfileExtraction } from "./handlers/profile-extraction.js";
import { handleProfileFactsExtraction } from "./handlers/profile-facts-extraction.js";
import { handleOrderTranscribe } from "./handlers/order-transcribe.js";
import { handleOrderExtraction } from "./handlers/order-extraction.js";
import { handleMatchingRun } from "./handlers/matching-run.js";
import { handleNotificationDispatch } from "./handlers/notification-dispatch.js";
import { dispatchRematches } from "./rematch.js";
import { dispatchProfileRebuilds, handleProfileRebuild } from "./profile-rebuild.js";

async function main() {
  loadEnv();
  const boss = await getBoss();

  await boss.work(JOB_TYPES.PROFILE_TRANSCRIBE, handleProfileTranscribe);
  await boss.work(JOB_TYPES.PROFILE_EXTRACTION, handleProfileExtraction);
  // Phase 1 profile_facts (SHADOW): separate job; never read by matching.
  await boss.work(JOB_TYPES.PROFILE_FACTS_EXTRACTION, handleProfileFactsExtraction);
  // Source revoke (2026-09-28): rebuild the AI profile from the remaining non-revoked messages.
  await boss.work(JOB_TYPES.PROFILE_REBUILD, (job: Parameters<typeof handleProfileRebuild>[0]) => handleProfileRebuild(job));
  await boss.work(JOB_TYPES.ORDER_TRANSCRIBE, handleOrderTranscribe);
  await boss.work(JOB_TYPES.ORDER_EXTRACTION, handleOrderExtraction);
  await boss.work(JOB_TYPES.MATCHING_RUN, handleMatchingRun);
  await boss.work(JOB_TYPES.NOTIFICATION_DISPATCH, handleNotificationDispatch);
  const heartbeat = () => writeFile(join(tmpdir(), "ustal-worker-heartbeat"), "ok");
  await heartbeat();
  let dispatching = false;
  let tick = 0;
  setInterval(async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      // Every minute: safety net for rebuilds the API could not enqueue (profile stays out of matching).
      if (tick++ % 6 === 0)
        await dispatchProfileRebuilds().catch(() =>
          console.error("Profile rebuild dispatch failed; retried on the next tick"));
      await dispatchRematches();
      await heartbeat();
    } catch {
      console.error(
        "Rematch outbox dispatch failed; durable requests retained for retry",
      );
    } finally {
      dispatching = false;
    }
  }, 10000);
  // MODERATION/EMBEDDING как отдельные job type не потребовались — вошли
  // внутрь profile/order extraction handlers.

  // eslint-disable-next-line no-console
  console.log("USTAL worker started, listening for jobs.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start worker:", err);
  process.exit(1);
});
