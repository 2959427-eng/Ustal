export interface ConsentPolicy { id: string; purpose: string; version: string; policyHash: string; status: string; content: { humanText?: string } }
export interface ConsentSnapshot { revision: number; aiConsentPurpose?: string | null; outboundEnforcement: boolean; policies: ConsentPolicy[]; decisions: { purpose: string; policyId: string; policyHash: string; decision: "grant" | "revoke"; effective: boolean }[] }
export function consentRequest(s: ConsentSnapshot, purpose: string, decision: "grant" | "revoke") {
  const p = s.policies.find(p => p.purpose === purpose);
  const previous = s.decisions.find(d => d.purpose === purpose);
  if (decision === "revoke") {
    if (!previous || previous.decision !== "grant") throw new Error("Нет разрешения для отзыва");
    return { policyId: previous.policyId, policyHash: previous.policyHash, decision, expectedRevision: s.revision };
  }
  if (!s.aiConsentPurpose || s.aiConsentPurpose !== purpose) throw new Error("Назначение согласия не подтверждено сервером");
  if (!s.outboundEnforcement) throw new Error("Защита передачи AI ещё не включена сервером. Изменение согласия недоступно.");
  if (!p || p.status !== "approved" || !p.content.humanText?.trim() || /TBD|TODO|PLACEHOLDER|DRAFT|ЧЕРНОВИК|ПРОЕКТ|\[USTAL_/i.test(p.content.humanText)) throw new Error("Утверждённые условия пока недоступны");
  return { policyId: p.id, policyHash: p.policyHash, decision, expectedRevision: s.revision };
}
