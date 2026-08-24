import { loadEnv } from "@ustal/config";
import { getBoss, JOB_TYPES } from "@ustal/queue";
import { handleProfileExtraction } from "./handlers/profile-extraction.js";
import { handleOrderExtraction } from "./handlers/order-extraction.js";
import { handleMatchingRun } from "./handlers/matching-run.js";

async function main() {
  loadEnv();
  const boss = await getBoss();

  await boss.work(JOB_TYPES.PROFILE_EXTRACTION, handleProfileExtraction);
  await boss.work(JOB_TYPES.ORDER_EXTRACTION, handleOrderExtraction);
  await boss.work(JOB_TYPES.MATCHING_RUN, handleMatchingRun);
  // TODO Фазы 5-6: work(NOTIFICATION_DISPATCH) — обработчик в src/handlers/*.
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
