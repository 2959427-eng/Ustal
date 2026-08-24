import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, getSql } from "./client.js";

async function main() {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./src/migrations" });
  await getSql().end();
  // eslint-disable-next-line no-console
  console.log("Migrations applied.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", err);
  process.exit(1);
});
