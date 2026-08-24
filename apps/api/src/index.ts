import { loadEnv } from "@ustal/config";
import { buildApp } from "./app.js";

async function main() {
  const env = loadEnv();
  const app = await buildApp();
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start API:", err);
  process.exit(1);
});
