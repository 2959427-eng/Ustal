import Constants from "expo-constants";
import { ApiClient } from "@ustal/api-client";
import { getAccessToken, clearTokens } from "./session";

const baseUrl = (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ?? "http://localhost:4000";

let cachedToken: string | null = null;

export const apiClient = new ApiClient({
  baseUrl,
  getAccessToken: () => cachedToken,
  onUnauthorized: () => {
    // Восстановление сессии после перезапуска и refresh-flow — src/api/auth.ts;
    // здесь только реакция на явный 401 от бэкенда: локальный логаут.
    void clearTokens();
    cachedToken = null;
  },
});

export async function primeTokenCache(): Promise<void> {
  cachedToken = await getAccessToken();
}

export function setCachedAccessToken(token: string | null): void {
  cachedToken = token;
}
