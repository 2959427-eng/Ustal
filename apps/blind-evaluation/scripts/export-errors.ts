#!/usr/bin/env node
/**
 * Read-only export of FN/FP errors from blind evaluation.
 * Uses exact same logic as analyze-results.ts.
 * No database modifications, no OpenAI calls.
 */

import { createTestPool } from "../src/test-db-config.js";
import * as fs from "fs";
import * as path from "path";

interface ErrorCase {
  id: string;
  profile: unknown;
  order: unknown;
  expected: string;
  predicted: string;
  score?: number;
  reason?: string;
  trace?: unknown;
}

async function exportErrors(): Promise<void> {
  const evaluationId = "37f01fb9-2a8f-4a53-ba3d-3c9e95623bf8";
  const pool = createTestPool();

  try {
    console.log(`\nExporting errors from evaluation ${evaluationId}...\n`);

    // Query using EXACT same logic as analyze-results.ts
    const result = await pool.query(`
      SELECT 
        p.case_id,
        p.prediction->>'prediction_label' AS predicted,
        h.expected_label,
        h.profile_json as profile,
        h.order_json as "order",
        p.prediction as prediction_full
      FROM blind_evaluation.predictions p
      JOIN blind_evaluation.holdout_cases h USING(case_id)
      WHERE p.evaluation_id = $1
      ORDER BY p.case_id
    `, [evaluationId]);

    const errors: ErrorCase[] = [];
    let fnCount = 0;
    let fpCount = 0;

    for (const row of result.rows) {
      const caseId = row.case_id;
      const predicted = row.predicted; // "MATCH" or "REJECT" from JSON
      const expected = row.expected_label; // "MATCH" or "REJECT"
      const profile = row.profile;
      const order = row.order;
      const predictionFull = row.prediction_full;

      // FN: predicted REJECT, expected MATCH
      const isFN = predicted === "REJECT" && expected === "MATCH";
      // FP: predicted MATCH, expected REJECT
      const isFP = predicted === "MATCH" && expected === "REJECT";

      if (isFN || isFP) {
        if (isFN) fnCount++;
        if (isFP) fpCount++;

        const errorCase: ErrorCase = {
          id: caseId,
          profile,
          order,
          expected,
          predicted,
        };

        // Extract additional fields from prediction JSON if available
        if (predictionFull) {
          if (predictionFull.score !== undefined) errorCase.score = predictionFull.score;
          if (predictionFull.reason) errorCase.reason = predictionFull.reason;
          if (predictionFull.trace) errorCase.trace = predictionFull.trace;
        }

        errors.push(errorCase);
      }
    }

    console.log(`Found ${fnCount} FN, ${fpCount} FP (total: ${errors.length})\n`);

    if (errors.length === 0) {
      console.warn(`WARNING: No errors found. Check if evaluation ${evaluationId} exists and is complete.\n`);
    }

    // Write JSON
    const outputDir = path.join(process.cwd(), "docs", "evaluations");
    const outputFile = path.join(outputDir, "blind-errors-26.json");

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify({
      evaluation_id: evaluationId,
      total_errors: errors.length,
      false_negatives: fnCount,
      false_positives: fpCount,
      errors
    }, null, 2));

    console.log(`✓ Exported to: ${outputFile}`);
    console.log(`  File size: ${fs.statSync(outputFile).size} bytes\n`);

  } finally {
    await pool.end();
  }
}

exportErrors().catch(err => {
  console.error("Export failed:", err.message);
  process.exit(1);
});
