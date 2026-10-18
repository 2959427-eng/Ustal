import { createTestPool } from "../src/test-db-config.js";
import { loadHoldoutDataset, injectHoldoutCases } from "../src/holdout-injector.js";
async function main() {
  const dataset=loadHoldoutDataset();
  const pool=createTestPool();
  try {await injectHoldoutCases(pool,dataset);console.log("LOAD PASS: 100 frozen cases; SHA256 "+dataset.sha256);}
  finally {await pool.end();}
}
main().catch(error=>{console.error(error.code==="ENOENT"?"LOAD FAIL: semantic-blind-holdout-100.json not found":error.message);process.exitCode=1;});

