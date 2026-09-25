import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRuntimePool, verifyRuntimeIsolation } from "../src/pipeline-environment.js";
import { extractCasePrediction } from "../src/prediction-extractor.js";
import type { Pool } from "pg";

test("real SQL extractor scopes completed runs and users, without an extra score threshold", async()=>{
 const pool=createRuntimePool();
 await verifyRuntimeIsolation(pool);
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const city=(await client.query("INSERT INTO cities(name,region_name,federal_district,timezone) VALUES('Extractor test','TEST','TEST','UTC') RETURNING id")).rows[0].id;
  const user=(await client.query("INSERT INTO users(phone,password_hash,status) VALUES($1,'test','active') RETURNING id",[randomUUID().slice(0,20)])).rows[0].id;
  const order=(await client.query("INSERT INTO orders(author_id,city_id,source_text,status) VALUES($1,$2,'SQL fixture','published') RETURNING id",[user,city])).rows[0].id;
  const run=(await client.query("INSERT INTO matching_runs(order_id,started_at) VALUES($1,now()) RETURNING id",[order])).rows[0].id;
  const result={caseId:"unit",orderId:order,userId:user,matchingRunId:run};
  const sql=client as unknown as Pool;
  await assert.rejects(extractCasePrediction(sql,result),/incomplete/);
  await client.query("UPDATE matching_runs SET completed_at=now(),candidates_count=0 WHERE id=$1",[run]);
  assert.equal((await extractCasePrediction(sql,result)).prediction_label,"REJECT");
  await client.query("INSERT INTO matching_candidates(matching_run_id,user_id,score,match_type,explanation,breakdown) VALUES($1,$2,1,'exact','fixture','{}')",[run,user]);
  assert.equal((await extractCasePrediction(sql,result)).prediction_label,"MATCH");
  assert.equal((await extractCasePrediction(sql,{...result,userId:randomUUID()})).prediction_label,"REJECT");
  await assert.rejects(extractCasePrediction(sql,{...result,matchingRunId:randomUUID()}),/absent/);
 } finally {await client.query("ROLLBACK");client.release();await pool.end();}
});

