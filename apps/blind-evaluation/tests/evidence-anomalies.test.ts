import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptCase, assertCompleteCoverage } from "../src/evidence-anomalies.js";

test("evidence failure is needs_review, other 99 cases continue without a fabricated prediction", async () => {
  const predictions: string[] = [], anomalies: string[] = [];
  for (let i=0;i<100;i++) {
    const attempt=await attemptCase(async()=>{
      if(i===1) throw Object.assign(new Error("evidence"),{code:"EVIDENCE_VALIDATION_ERROR",diagnostic:{field:"profileEvidence",evidence:"fabricated",sources:["original"]}});
      return String(i);
    });
    if(attempt.anomaly) {
      anomalies.push(String(i));
      assert.equal(attempt.anomaly.disposition,"needs_review");
      assert.equal(attempt.result,undefined);
      assert.equal(attempt.anomaly.diagnostic.evidence,"fabricated");
    } else predictions.push(attempt.result);
  }
  assert.equal(predictions.length,99);assert.deepEqual(anomalies,["1"]);
  assertCompleteCoverage(predictions,anomalies,100);
});
test("auth and DB errors are not masked as evidence anomalies",async()=>{
  await assert.rejects(attemptCase(async()=>{throw new Error("401 unauthorized");}),/401/);
});
test("analysis refuses missing or duplicate coverage",()=>{
  assert.throws(()=>assertCompleteCoverage(["one"],[],2));
  assert.throws(()=>assertCompleteCoverage(["one"],["one"],2));
});
