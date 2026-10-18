export interface EvidenceAnomaly {
  status: "evidence_validation_error";
  disposition: "needs_review";
  diagnostic: { field: string; evidence: string; sources: string[] };
}

/** Only evidence failures are isolated. Auth/DB/transport failures must remain visible. */
export async function attemptCase<T>(run: () => Promise<T>): Promise<{ result: T; anomaly?: never } | { result?: never; anomaly: EvidenceAnomaly }> {
  try { return { result: await run() }; }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EVIDENCE_VALIDATION_ERROR" || !("diagnostic" in error)) throw error;
    const diagnostic = error.diagnostic as EvidenceAnomaly["diagnostic"];
    if (!diagnostic || typeof diagnostic.field !== "string" || typeof diagnostic.evidence !== "string" ||
        !Array.isArray(diagnostic.sources) || !diagnostic.sources.every(source => typeof source === "string")) throw error;
    return { anomaly: { status: "evidence_validation_error", disposition: "needs_review", diagnostic } };
  }
}

export function assertCompleteCoverage(predictedIds: string[], anomalyIds: string[], expected: number): void {
  const ids = [...predictedIds, ...anomalyIds];
  if (ids.length !== expected || new Set(ids).size !== expected) throw new Error("Incomplete or overlapping case coverage; no metrics published");
}
