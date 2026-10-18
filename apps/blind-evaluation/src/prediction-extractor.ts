import type { Pool } from "pg";
import type { PipelineResult } from "./live-adapter.js";
export interface CasePrediction {
  case_id: string; prediction_label: "MATCH" | "REJECT"; confidence_score: number | null;
  matched_candidate_count: number; matching_run_id: string | null; decision_reason: string; extracted_at: Date;
}
// Candidate presence is the production decision: no additional score threshold.
export async function extractCasePrediction(pool: Pool, result: PipelineResult): Promise<CasePrediction> {
  const base = {case_id:result.caseId, extracted_at:new Date(), matching_run_id:result.matchingRunId};
  if (!result.matchingRunId) {
    const order = await pool.query("SELECT moderation_status FROM public.orders WHERE id=$1", [result.orderId]);
    if (!["reject","manual_review"].includes(order.rows[0]?.moderation_status)) throw new Error("Missing matching run is not a completed rejection");
    return {...base,prediction_label:"REJECT",confidence_score:null,matched_candidate_count:0,decision_reason:"moderation_"+order.rows[0].moderation_status};
  }
  const run = await pool.query("SELECT completed_at FROM public.matching_runs WHERE id=$1 AND order_id=$2", [result.matchingRunId,result.orderId]);
  if (!run.rows[0]?.completed_at) throw new Error("Matching run absent or incomplete; not a rejection");
  const candidates = await pool.query("SELECT score, match_type FROM public.matching_candidates WHERE matching_run_id=$1 AND user_id=$2", [result.matchingRunId,result.userId]);
  if ((candidates.rowCount || 0) > 1) throw new Error("Ambiguous duplicate candidate");
  const trace = await pool.query("SELECT decision FROM public.matching_traces WHERE matching_run_id=$1 AND user_id=$2", [result.matchingRunId,result.userId]);
  // «Простая задача» (general access, 2026-10-15) — отдельный путь показа, не решение подбора: в blind это не MATCH,
  // а отдельная пометка в decision_reason (метки датасета не меняются, метрики opportunity считаются отдельно).
  const candidate = candidates.rows[0]?.match_type === "opportunity" ? undefined : candidates.rows[0];
  const opportunity = candidates.rows[0]?.match_type === "opportunity";
  return {...base, prediction_label:candidate ? "MATCH" : "REJECT", confidence_score:candidate ? Number(candidate.score) : null,
    matched_candidate_count:candidate ? (candidates.rowCount || 0) : 0,
    decision_reason:opportunity ? "general_access_opportunity" : (trace.rows[0]?.decision || "not_shortlisted")};
}

