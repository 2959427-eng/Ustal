import { getSql } from "@ustal/database";
import { reprocessOrder, reprocessProfile } from "./reprocess.js";

async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => args[args.indexOf(name) + 1];
  const id = value("--id");
  if (!args.includes("--id") || !/^[0-9a-f-]{36}$/i.test(id ?? ""))
    throw new Error(
      "Usage: reprocess-cli.ts --kind profile|order --id UUID [--source-input-id UUID] [--apply]",
    );
  const apply = args.includes("--apply");
  const result =
    value("--kind") === "profile"
      ? await reprocessProfile(
          id!,
          args.includes("--source-input-id")
            ? value("--source-input-id")
            : undefined,
          apply,
        )
      : value("--kind") === "order"
        ? await reprocessOrder(id!, apply)
        : null;
  if (!result) throw new Error("--kind must be profile or order");
  console.log(JSON.stringify(result));
}
main()
  .catch(() => {
    console.error(
      "Reprocess failed; source/state validation or processing failed. No automatic destructive recovery.",
    );
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
