import { getSql } from "@ustal/database";
import { getBoss } from "@ustal/queue";
import { profileInputRecoveryStatus, resetProfileInputRecovery } from "./profile-input-recovery.js";

/**
 * Явная повторная обработка сообщения профиля после исчерпания лимита неудач (QA 2026-10-14, дефект №2).
 *   tsx src/retry-profile-input-cli.ts --id <sourceInputId>            — показать состояние
 *   tsx src/retry-profile-input-cli.ts --id <sourceInputId> --apply    — обнулить счётчик и поставить задачу
 */
async function main() {
  const args = process.argv.slice(2);
  const id = args[args.indexOf("--id") + 1];
  if (!args.includes("--id") || !/^[0-9a-f-]{36}$/i.test(id ?? ""))
    throw new Error("Usage: retry-profile-input-cli.ts --id UUID [--apply]");
  const before = await profileInputRecoveryStatus(id!);
  const result = args.includes("--apply") ? await resetProfileInputRecovery(id!) : { dryRun: true };
  console.log(JSON.stringify({ before, result }, null, 2));
  if (args.includes("--apply")) await (await getBoss()).stop({ graceful: true });
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "retry-profile-input failed");
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
