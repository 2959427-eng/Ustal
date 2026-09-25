#!/usr/bin/env node
import { assertLiveAiEnvironment, safeEnvironmentError } from "../src/environment.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createTestPool } from "../src/test-db-config.js";
import { datasetPath, inputText } from "../src/holdout-injector.js";
import { createLiveAdapter } from "../src/live-adapter.js";
import { extractCasePrediction } from "../src/prediction-extractor.js";
import { attemptCase, assertCompleteCoverage } from "../src/evidence-anomalies.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
  const resumeMode = process.argv.includes("--resume") || process.env.RESUME === "true";
  
  if (!dryRun && !resumeMode && process.env.CONFIRM_EVALUATION !== "true") {
    throw new Error("Live execution requires CONFIRM_EVALUATION=true or --resume flag");
  }
  
  if (!dryRun) assertLiveAiEnvironment();

  if (dryRun) {
    globalThis.fetch = async () => { throw new Error("Network AI call forbidden in dry-run"); };
  }
  
  const sha = createHash("sha256").update(readFileSync(datasetPath())).digest("hex");
  if (sha !== "53b5c42387ff4ba29fcafa7debfe89b8faae2255e54d8c3dd057cb9fa7975bd3") {
    throw new Error("Frozen dataset SHA256 mismatch");
  }
  
  const pool = createTestPool();
  let adapter: Awaited<ReturnType<typeof createLiveAdapter>> | undefined;
  
  try {
    // Evaluation-owned diagnostic records, never application matching outcomes.
    await pool.query(`CREATE TABLE IF NOT EXISTS blind_evaluation.evidence_anomalies (
      evaluation_id uuid REFERENCES blind_evaluation.evaluation_runs(id), case_id text NOT NULL,
      detail jsonb NOT NULL, PRIMARY KEY(evaluation_id,case_id))`);
    const manifest = await pool.query("SELECT sha256, case_count FROM blind_evaluation.dataset_manifest");
    if (manifest.rows[0]?.sha256 !== sha || manifest.rows[0]?.case_count !== 100) {
      throw new Error("Dataset not loaded or manifest mismatch");
    }
    
    const result = await pool.query(
      "SELECT case_id, profile_json, order_json FROM blind_evaluation.holdout_cases ORDER BY case_id"
    );
    if (result.rows.length !== 100) {
      throw new Error("Expected exactly 100 cases");
    }
    
    const inputs = result.rows.map((row) => {
      const profileText = inputText(row.profile_json);
      const orderText = inputText(row.order_json);
      if (!profileText || !orderText) throw new Error("Missing source text");
      return { caseId: String(row.case_id), profileText, orderText };
    });
    
    adapter = await createLiveAdapter(dryRun ? "dry" : "live");
    
    // Resolve every real schema touched by worker stages, without writes or inference.
    for (const table of [
      "orders",
      "users",
      "user_profiles",
      "profile_source_inputs",
      "capability_profiles",
      "matching_documents",
      "matching_facts",
      "matching_runs",
      "matching_candidates",
      "matching_traces",
      "ai_runs",
      "rematch_requests",
    ]) {
      await adapter.pool.query('SELECT 1 FROM public."' + table + '" LIMIT 0');
    }
    
    const vector = await adapter.pool.query("SELECT 1 FROM pg_extension WHERE extname='vector'");
    const ontology = await adapter.pool.query("SELECT count(*)::int AS n FROM public.ontology_nodes");
    if (!vector.rowCount || !ontology.rows[0].n) {
      throw new Error("pgvector or standard seed missing");
    }
    
    if (dryRun) {
      // DRY-RUN MODE: Check resume state without executing pipeline
      let evaluationId: string;
      let processedCaseIds: Set<string> = new Set();
      
      if (resumeMode) {
        const latestEval = await pool.query(
          "SELECT id, case_count FROM blind_evaluation.evaluation_runs WHERE dataset_sha256 = $1 ORDER BY started_at DESC LIMIT 1",
          [sha]
        );
        
        if (latestEval.rows[0]) {
          evaluationId = latestEval.rows[0].id;
          const processed = await pool.query(
            "SELECT case_id FROM blind_evaluation.predictions WHERE evaluation_id = $1 UNION SELECT case_id FROM blind_evaluation.evidence_anomalies WHERE evaluation_id = $1",
            [evaluationId]
          );
          processedCaseIds = new Set(processed.rows.map((r) => String(r.case_id)));
          console.log(`DRY-RUN RESUME: Found evaluation ${evaluationId}`);
          console.log(`  Total expected: 100 cases, Previous: ${latestEval.rows[0].case_count}`);
          console.log(`  Already processed: ${processedCaseIds.size} cases`);
          console.log(`  Remaining: ${100 - processedCaseIds.size} cases`);
        } else {
          console.log("DRY-RUN RESUME: No previous evaluation found. Would start fresh with all 100 cases.");
          processedCaseIds = new Set();
        }
      } else {
        console.log("DRY-RUN FRESH: Would start fresh evaluation with all 100 cases.");
      }
      
      console.log(
        "\nDRY_RUN PASS: 100 cases, SHA256 verified, real handler imports and DB identity verified, runtime labels denied, pgvector and schema ready."
      );
      console.log("No pipeline execution, no OpenAI calls, no predictions or metrics generated.");
      console.log(`Resume processed count: ${processedCaseIds.size}`);
      return;
    }
    
    // LIVE EXECUTION: Load/create evaluation and process remaining cases
    let evaluationId: string;
    let processedCaseIds: Set<string> = new Set();
    
    if (resumeMode) {
      const latestEval = await pool.query(
        "SELECT id FROM blind_evaluation.evaluation_runs WHERE dataset_sha256 = $1 AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1",
        [sha]
      );
      
      if (!latestEval.rows[0]) {
        console.log("RESUME: No incomplete evaluation found. Starting fresh.");
        evaluationId = randomUUID();
      } else {
        evaluationId = latestEval.rows[0].id;
        const processed = await pool.query(
          "SELECT case_id FROM blind_evaluation.predictions WHERE evaluation_id = $1 UNION SELECT case_id FROM blind_evaluation.evidence_anomalies WHERE evaluation_id = $1",
          [evaluationId]
        );
        processedCaseIds = new Set(processed.rows.map((r) => String(r.case_id)));
        console.log(`RESUME: Continuing evaluation ${evaluationId}`);
        console.log(`  Already processed: ${processedCaseIds.size}/100 cases`);
      }
    } else {
      evaluationId = randomUUID();
    }
    
    await pool.query(
      "INSERT INTO blind_evaluation.evaluation_runs(id, dataset_sha256, case_count) VALUES($1, $2, 100) ON CONFLICT(id) DO NOTHING",
      [evaluationId, sha]
    );
    
    const casesToProcess = inputs.filter((i) => !processedCaseIds.has(i.caseId));
    console.log(`\nProcessing ${casesToProcess.length} cases (${processedCaseIds.size} already done)...`);
    
    for (let idx = 0; idx < casesToProcess.length; idx++) {
      const input = casesToProcess[idx];
      if (!input) throw new Error("Missing evaluation input");
      const attempt = await attemptCase(() => adapter!.run(input));
      if (attempt.anomaly) {
        await pool.query("INSERT INTO blind_evaluation.evidence_anomalies(evaluation_id,case_id,detail) VALUES($1,$2,$3)",
          [evaluationId,input.caseId,JSON.stringify(attempt.anomaly)]);
        console.log(`[${processedCaseIds.size + idx + 1}/100] Case ${input.caseId}: evidence_validation_error / needs_review`);
        continue;
      }
      const actual = attempt.result;
      const prediction = await extractCasePrediction(adapter.pool, actual);
      
      // CRITICAL: prediction extracted BEFORE reading expected_label
      // Predictions sealed in DB, label remains unread in memory until analysis phase
      await pool.query(
        "INSERT INTO blind_evaluation.predictions(evaluation_id, case_id, order_id, user_id, matching_run_id, prediction) VALUES($1, $2, $3, $4, $5, $6)",
        [evaluationId, input.caseId, actual.orderId, actual.userId, actual.matchingRunId, JSON.stringify(prediction)]
      );
      
      console.log(`[${processedCaseIds.size + idx + 1}/100] Case ${input.caseId} completed.`);
    }
    
    const classified = await pool.query("SELECT case_id FROM blind_evaluation.predictions WHERE evaluation_id=$1",[evaluationId]);
    const anomalies = await pool.query("SELECT case_id FROM blind_evaluation.evidence_anomalies WHERE evaluation_id=$1",[evaluationId]);
    assertCompleteCoverage(classified.rows.map(row=>row.case_id),anomalies.rows.map(row=>row.case_id),100);
    await pool.query("UPDATE blind_evaluation.evaluation_runs SET completed_at = now() WHERE id = $1", [evaluationId]);
    console.log(
      `\nCompleted evaluation ${evaluationId}; ${classified.rowCount} predictions, ${anomalies.rowCount} evidence anomalies. Labels remain unread.`
    );
  } finally {
    if (adapter) await adapter.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    error.code === "ENOENT"
      ? "Holdout file missing"
      : safeEnvironmentError(error)
  );
  process.exitCode = 1;
});
