import { apiClient, getApiBaseUrl } from "./client";
import type { LegalDocumentId, LegalDocumentInfo } from "../lib/registration-consent";

export { registrationDocumentsReady, type LegalDocumentId, type LegalDocumentInfo } from "../lib/registration-consent";

export async function getLegalDocuments(): Promise<LegalDocumentInfo[]> {
  return (await apiClient.request<{ documents: LegalDocumentInfo[] }>("/legal")).documents;
}
export const legalDocumentUrl = (id: LegalDocumentId) => `${getApiBaseUrl().replace(/\/$/, "")}/legal/${id}`;
