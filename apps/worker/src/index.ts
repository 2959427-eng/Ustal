import { loadEnv } from "@ustal/config";
import { getBoss, JOB_TYPES } from "@ustal/queue";
import { handleProfileExtraction } from "./handlers/profile-extraction.js";
import { handleOrderExtraction } from "./handlers/order-extraction.js";

async function main() {
  loadEnv();
  const boss = await getBoss();

  await boss.work(JOB_TYPES.PROFILE_EXTRACTION, handleProfileExtraction);
  await boss.work(JOB_TYPES.ORDER_EXTRACTION, handleOrderExtraction);
  // TODO Фазы 4-6: work(MATCHING_RUN), work(NOTIFICATION_DISPATCH) —
  // обработчики в src/handlers/*. MODERATION/EMBEDDING как отдельные job type
  // не потребовались — вошли внутрь profile/order extraction handlers.

  // eslint-disable-next-line no-console
  console.log("USTAL worker started, listening for jobs.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start worker:", err);
  process.exit(1);
});
