import { Pool } from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getTestDbConfig, verifyTestDbIsolation } from "../src/test-db-config.js";
import { databaseUrl, runtimeConfig, repoRoot } from "../src/pipeline-environment.js";

async function main() {
  const config=getTestDbConfig(), runtime=runtimeConfig();
  if(!verifyTestDbIsolation(config).isolated) throw new Error("Not a local test DB");
  const admin=new Pool({...config,user:process.env.TEST_DB_ADMIN_USER || "postgres",password:process.env.TEST_DB_ADMIN_PASSWORD,connectionTimeoutMillis:5000});
  try {
    const id=await admin.query("SELECT current_database() AS db");
    if(id.rows[0].db!==config.database)throw new Error("Wrong setup database");
    // Public is the unchanged application schema, in the dedicated test DB only.
    await admin.query('GRANT USAGE, CREATE ON SCHEMA public TO "'+config.user+'"');
    if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[runtime.user])).rowCount) {
      await admin.query('CREATE ROLE "'+runtime.user+'" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '+ "'" +runtime.password.replaceAll("'","''")+ "'");
    }
    await admin.query('GRANT CONNECT ON DATABASE "'+config.database+'" TO "'+runtime.user+'"');
    await admin.query('REVOKE ALL ON SCHEMA blind_evaluation FROM PUBLIC, "'+runtime.user+'"');
  } finally { await admin.end(); }
  const env={...process.env,NODE_ENV:"test",AI_PROVIDER:"mock",DATABASE_URL:databaseUrl(config)};
  // Use the repository migration and seed entrypoints, unchanged.
  for(const script of ["migrate.ts","seed.ts"]) {
    const child=spawnSync(process.execPath,["--import","tsx","src/"+script],{
      cwd:repoRoot+"packages/database",env,encoding:"utf8"});
    if(child.status!==0)throw new Error("Existing database "+script+" failed (exit "+child.status+"): "+child.stderr);
    console.log("Existing "+script+": PASS");
  }
  const owner=new Pool({...config,connectionTimeoutMillis:5000});
  try {
    await owner.query('GRANT USAGE ON SCHEMA public TO "'+runtime.user+'"');
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "'+runtime.user+'"');
    await owner.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "'+runtime.user+'"');
    await owner.query(`CREATE TABLE IF NOT EXISTS blind_evaluation.dataset_manifest (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), sha256 text NOT NULL, case_count integer NOT NULL)`);
    await owner.query(`CREATE TABLE IF NOT EXISTS blind_evaluation.evaluation_runs (
      id uuid PRIMARY KEY, dataset_sha256 text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz, case_count integer NOT NULL)`);
    await owner.query(`CREATE TABLE IF NOT EXISTS blind_evaluation.predictions (
      evaluation_id uuid REFERENCES blind_evaluation.evaluation_runs(id), case_id text NOT NULL,
      order_id uuid NOT NULL, user_id uuid NOT NULL, matching_run_id uuid, prediction jsonb NOT NULL,
      PRIMARY KEY(evaluation_id,case_id))`);
    console.log("Pipeline schema, unchanged seed and restricted runtime role: PASS");
  } finally { await owner.end(); }
}
main().catch(error=>{let message=String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,"[DATABASE]");for(const key of ["TEST_DB_PASSWORD","TEST_DB_ADMIN_PASSWORD","TEST_DB_RUNTIME_PASSWORD"])if(process.env[key])message=message.split(process.env[key]!).join("[REDACTED]");console.error(message);process.exitCode=1;});

