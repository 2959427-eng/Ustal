import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv } from "@ustal/config";
import { getBoss, JOB_TYPES } from "@ustal/queue";
import { handleProfileTranscribe } from "./handlers/profile-transcribe.js";
import { runProfileExtractionJob } from "./handlers/profile-extraction.js";
import { handleProfileFactsExtraction } from "./handlers/profile-facts-extraction.js";
import { handleOrderTranscribe } from "./handlers/order-transcribe.js";
import { handleOrderExtraction } from "./handlers/order-extraction.js";
import { handleMatchingRun } from "./handlers/matching-run.js";
import { handleNotificationDispatch } from "./handlers/notification-dispatch.js";
import { dispatchRematches } from "./rematch.js";
import { dispatchProfileRebuilds, handleProfileRebuild } from "./profile-rebuild.js";
import { dispatchStalledProfileInputs } from "./profile-input-recovery.js";
import { dispatchDeliveryWaves } from "./order-delivery-waves.js";
import { dispatchEmbeddingRefreshes, handleProfileEmbeddingRefresh } from "./handlers/profile-embedding-refresh.js";

async function main() {
  loadEnv();
  const boss = await getBoss();

  await boss.work(JOB_TYPES.PROFILE_TRANSCRIBE, handleProfileTranscribe);
  await boss.work(JOB_TYPES.PROFILE_EXTRACTION, runProfileExtractionJob);
  // Phase 1 profile_facts (SHADOW): separate job; never read by matching.
  await boss.work(JOB_TYPES.PROFILE_FACTS_EXTRACTION, handleProfileFactsExtraction);
  // Source revoke (2026-09-28): rebuild the AI profile from the remaining non-revoked messages.
  await boss.work(JOB_TYPES.PROFILE_REBUILD, (job: Parameters<typeof handleProfileRebuild>[0]) => handleProfileRebuild(job));
  await boss.work(JOB_TYPES.PROFILE_EMBEDDING_REFRESH, handleProfileEmbeddingRefresh);
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
      // Every minute (first tick right after start): profile messages whose job was lost or failed
      // (QA 2026-10-14, defect 2). State lives in the DB, so a restarted worker resumes the same way.
      if (tick % 6 === 1)
        await dispatchStalledProfileInputs().catch(() =>
          console.error("Profile input recovery failed; retried on the next tick"));
      // Every minute: next delivery wave for published orders with too few responses (2026-10-15).
      if (tick % 6 === 2)
        await dispatchDeliveryWaves().catch(() =>
          console.error("Delivery wave dispatch failed; retried on the next tick"));
      // Every minute: profile vector refreshes whose job was lost or could not be enqueued (2026-10-17).
      if (tick % 6 === 3)
        await dispatchEmbeddingRefreshes().catch(() =>
          console.error("Embedding refresh dispatch failed; retried on the next tick"));
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
