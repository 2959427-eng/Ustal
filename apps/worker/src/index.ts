import { loadEnv } from "@ustal/config";
import { getBoss, JOB_TYPES } from "./queue.js";
import { handleProfileExtraction } from "./handlers/profile-extraction.js";

async function main() {
  loadEnv();
  const boss = await getBoss();

  await boss.work(JOB_TYPES.PROFILE_EXTRACTION, handleProfileExtraction);
  // TODO Фазы 3-6: work(ORDER_EXTRACTION), work(MODERATION), work(EMBEDDING),
  // work(MATCHING_RUN), work(NOTIFICATION_DISPATCH) — обработчики в src/handlers/*.

  // eslint-disable-next-line no-console
  console.log("USTAL worker started, listening for jobs.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start worker:", err);
  process.exit(1);
});
