import { test } from "node:test";
import assert from "node:assert/strict";
import { getTestDbConfig, verifyTestDbIsolation } from "../src/test-db-config.js";
const local = {host:"127.0.0.1",port:5432,database:"ustal_blind_test",user:"ustal_blind_test",password:"unused",schema:"blind_evaluation"};
test("accepts dedicated local test configuration", () => assert.equal(verifyTestDbIsolation(local).isolated,true));
test("rejects remote host and invalid port", () => {
  assert.equal(verifyTestDbIsolation({...local,host:"example.com"}).isolated,false);
  assert.equal(verifyTestDbIsolation({...local,port:NaN}).isolated,false);
});
test("explicit DB name cannot bypass isolation", () => {
  const previous=process.env.TEST_DB_NAME;
  try { process.env.TEST_DB_NAME="ustal"; assert.equal(verifyTestDbIsolation(getTestDbConfig()).isolated,false); }
  finally { if(previous===undefined) delete process.env.TEST_DB_NAME; else process.env.TEST_DB_NAME=previous; }
});
test("rejects production role or public schema", () => {
  assert.equal(verifyTestDbIsolation({...local,user:"ustal"}).isolated,false);
  assert.equal(verifyTestDbIsolation({...local,schema:"public"}).isolated,false);
});
