import { createTestPool } from "../src/test-db-config.js";
import { computeConfusionMatrix, computeMetrics } from "../src/metrics-calculator.js";
import { assertCompleteCoverage } from "../src/evidence-anomalies.js";
async function main(){
 const pool=createTestPool();
 try{
  const run=await pool.query("SELECT id,completed_at FROM blind_evaluation.evaluation_runs ORDER BY started_at DESC LIMIT 1");
  if(!run.rows[0]?.completed_at)throw new Error("Latest live evaluation is incomplete; cannot calculate metrics");
  const rows=await pool.query("SELECT p.case_id, p.prediction->>'prediction_label' AS predicted, h.expected_label FROM blind_evaluation.predictions p JOIN blind_evaluation.holdout_cases h USING(case_id) WHERE p.evaluation_id=$1",[run.rows[0].id]);
  const anomalies=await pool.query("SELECT case_id,detail FROM blind_evaluation.evidence_anomalies WHERE evaluation_id=$1 ORDER BY case_id",[run.rows[0].id]);
  assertCompleteCoverage(rows.rows.map(row=>row.case_id),anomalies.rows.map(row=>row.case_id),100);
  if(rows.rows.some(row=>!["MATCH","REJECT"].includes(row.predicted)))throw new Error("Unknown prediction label");
  const labels=new Map<string,"MATCH"|"REJECT">(rows.rows.map(r=>[r.case_id,r.expected_label]));
  const result=computeConfusionMatrix(rows.rows,labels);
  console.log(JSON.stringify({evaluation_id:run.rows[0].id,attempted:100,classified:rows.rowCount,needs_review:anomalies.rowCount,
    metrics_scope:"classified cases only; evidence anomalies are NOT MATCH or REJECT",fully_classified:anomalies.rowCount===0,
    confusion_matrix:result.matrix,metrics:computeMetrics(result.matrix),evidence_validation_anomalies:anomalies.rows},null,2));
 }finally{await pool.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

