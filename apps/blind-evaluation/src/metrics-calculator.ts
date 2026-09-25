/**
 * Metrics calculator - computes confusion matrix and evaluation metrics.
 *
 * Input:
 * - predictions: array of {case_id, prediction_label} (extracted from pipeline)
 * - expected_labels: array of {case_id, expected_label} (unsealed after prediction)
 *
 * Output:
 * - Confusion matrix: TP, TN, FP, FN
 * - Metrics: precision, recall, F1
 * - Per-category analysis
 */

export interface ConfusionMatrix {
  tp: number; // True positives: predicted MATCH, expected MATCH
  tn: number; // True negatives: predicted REJECT, expected REJECT
  fp: number; // False positives: predicted MATCH, expected REJECT
  fn: number; // False negatives: predicted REJECT, expected MATCH
}

export interface ClassificationMetrics {
  precision: number; // TP / (TP + FP)
  recall: number; // TP / (TP + FN)
  f1: number; // 2 * (precision * recall) / (precision + recall)
  accuracy: number; // (TP + TN) / (TP + TN + FP + FN)
  specificity: number; // TN / (TN + FP)
}

export interface CaseResult {
  case_id: string;
  predicted: "MATCH" | "REJECT";
  expected: "MATCH" | "REJECT";
  correct: boolean;
  case_type: "tp" | "tn" | "fp" | "fn";
}

export interface EvaluationResults {
  confusion_matrix: ConfusionMatrix;
  metrics: ClassificationMetrics;
  case_results: CaseResult[];
  error_cases: {
    fp_cases: CaseResult[]; // False positives to analyze
    fn_cases: CaseResult[]; // False negatives to analyze
  };
}

/**
 * Compute confusion matrix from predictions and expected labels.
 */
export function computeConfusionMatrix(
  predictions: Array<{ case_id: string; predicted: "MATCH" | "REJECT" }>,
  expectedLabels: Map<string, "MATCH" | "REJECT">,
): {
  matrix: ConfusionMatrix;
  cases: CaseResult[];
} {
  const matrix: ConfusionMatrix = {
    tp: 0,
    tn: 0,
    fp: 0,
    fn: 0,
  };

  const cases: CaseResult[] = [];

  for (const pred of predictions) {
    const expected = expectedLabels.get(pred.case_id);
    if (!expected) {
      console.warn(`[MetricsCalculator] No expected label for case ${pred.case_id}`);
      continue;
    }

    let case_type: "tp" | "tn" | "fp" | "fn";
    const correct = pred.predicted === expected;

    if (pred.predicted === "MATCH" && expected === "MATCH") {
      matrix.tp++;
      case_type = "tp";
    } else if (pred.predicted === "REJECT" && expected === "REJECT") {
      matrix.tn++;
      case_type = "tn";
    } else if (pred.predicted === "MATCH" && expected === "REJECT") {
      matrix.fp++;
      case_type = "fp";
    } else {
      // pred.predicted === "REJECT" && expected === "MATCH"
      matrix.fn++;
      case_type = "fn";
    }

    cases.push({
      case_id: pred.case_id,
      predicted: pred.predicted,
      expected,
      correct,
      case_type,
    });
  }

  return { matrix, cases };
}

/**
 * Compute classification metrics from confusion matrix.
 */
export function computeMetrics(matrix: ConfusionMatrix): ClassificationMetrics {
  const { tp, tn, fp, fn } = matrix;
  const total = tp + tn + fp + fn;

  // Handle division by zero
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall > 0 ? (2 * (precision * recall)) / (precision + recall) : 0;
  const accuracy = total > 0 ? (tp + tn) / total : 0;
  const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;

  return {
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    accuracy: Number(accuracy.toFixed(3)),
    specificity: Number(specificity.toFixed(3)),
  };
}

/**
 * Evaluate predictions against expected labels.
 * Returns full evaluation report including error analysis.
 */
export function evaluatePredictions(
  predictions: Array<{ case_id: string; predicted: "MATCH" | "REJECT" }>,
  expectedLabels: Map<string, "MATCH" | "REJECT">,
): EvaluationResults {
  const { matrix, cases } = computeConfusionMatrix(predictions, expectedLabels);
  const metrics = computeMetrics(matrix);

  const fp_cases = cases.filter((c) => c.case_type === "fp");
  const fn_cases = cases.filter((c) => c.case_type === "fn");

  return {
    confusion_matrix: matrix,
    metrics,
    case_results: cases,
    error_cases: {
      fp_cases,
      fn_cases,
    },
  };
}

/**
 * Format evaluation results for human reading.
 */
export function formatEvaluationResults(results: EvaluationResults): string {
  const { confusion_matrix, metrics, error_cases } = results;

  const lines = [
    "=== BLIND EVALUATION RESULTS ===\n",
    "Confusion Matrix:",
    `  True Positives (TP):  ${confusion_matrix.tp}`,
    `  True Negatives (TN):  ${confusion_matrix.tn}`,
    `  False Positives (FP): ${confusion_matrix.fp}`,
    `  False Negatives (FN): ${confusion_matrix.fn}`,
    `  Total:                ${confusion_matrix.tp + confusion_matrix.tn + confusion_matrix.fp + confusion_matrix.fn}`,
    "",
    "Classification Metrics:",
    `  Precision: ${metrics.precision}`,
    `  Recall:    ${metrics.recall}`,
    `  F1 Score:  ${metrics.f1}`,
    `  Accuracy:  ${metrics.accuracy}`,
    `  Specificity: ${metrics.specificity}`,
    "",
    `False Positives (${error_cases.fp_cases.length} cases):`,
  ];

  for (const c of error_cases.fp_cases.slice(0, 5)) {
    lines.push(`  - ${c.case_id}: predicted MATCH, expected REJECT`);
  }
  if (error_cases.fp_cases.length > 5) {
    lines.push(`  ... and ${error_cases.fp_cases.length - 5} more`);
  }

  lines.push("");
  lines.push(`False Negatives (${error_cases.fn_cases.length} cases):`);

  for (const c of error_cases.fn_cases.slice(0, 5)) {
    lines.push(`  - ${c.case_id}: predicted REJECT, expected MATCH`);
  }
  if (error_cases.fn_cases.length > 5) {
    lines.push(`  ... and ${error_cases.fn_cases.length - 5} more`);
  }

  return lines.join("\n");
}
