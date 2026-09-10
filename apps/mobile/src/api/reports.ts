import { apiClient } from "./client";

export type ReportTargetType = "order" | "user" | "response";

export interface SubmitReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  comment?: string;
}

export interface ReportCreated {
  id: string;
  status: string;
  createdAt: string;
}

/**
 * POST /reports (раздел 28 ТЗ) — жалоба на заказ, пользователя или отклик.
 * `reason` на сервере — свободная строка (max 100), не enum: типовые причины
 * задаются только на клиенте (src/components/ReportModal.tsx).
 */
export function submitReport(input: SubmitReportInput): Promise<ReportCreated> {
  return apiClient.request<ReportCreated>("/reports", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
