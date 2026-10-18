import { getSql } from "@ustal/database";
import { reprocessProfileFacts } from "./reprocess-facts.js";

/** Usage: tsx src/reprocess-facts-cli.ts (--source-input-id UUID | --user-id UUID | --all) [--apply] */
async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
  const sourceInputId = uuid(value("--source-input-id"));
  const userId = uuid(value("--user-id"));
  const all = args.includes("--all");
  if (!sourceInputId && !userId && !all)
    throw new Error("Usage: reprocess-facts-cli.ts (--source-input-id UUID | --user-id UUID | --all) [--apply]");
  console.log(JSON.stringify(await reprocessProfileFacts({ sourceInputId, userId, all }, args.includes("--apply"))));
}
main()
  .catch((error) => {
    console.error(`Profile facts reprocess failed: ${error instanceof Error ? error.name : "unknown"}`);
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
