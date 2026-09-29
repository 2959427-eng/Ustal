import { apiClient, primeTokenCache } from "./client";
import { refreshSession, type RefreshSessionResult } from "./auth";
import { withDeadline } from "../lib/deadline";

export async function restoreSession(): Promise<RefreshSessionResult> {
  try {
    return await withDeadline((async () => {
      await primeTokenCache();
      return refreshSession();
    })(), 35_000);
  } catch {
    apiClient.cancelAll();
    return { state: "storage_unavailable" };
  }
}
