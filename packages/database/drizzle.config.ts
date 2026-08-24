import type { Config } from "drizzle-kit";
import "dotenv/config";

export default {
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://ustal:ustal@localhost:5432/ustal",
  },
  verbose: true,
  strict: true,
} satisfies Config;
