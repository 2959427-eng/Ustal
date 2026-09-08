import Constants from "expo-constants";
import { ApiClient } from "@ustal/api-client";
import { getAccessToken } from "./session";

const baseUrl = (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ?? "http://localhost:4000";

let cachedToken: string | null = null;

export const apiClient = new ApiClient({
  baseUrl,
  getAccessToken: () => cachedToken,
  // 2026-09-08 fix: раньше здесь стоял безусловный clearTokens() на ЛЮБОЙ
  // 401 от ЛЮБОГО эндпоинта — включая обычный запрос с просто истёкшим
  // (не отозванным) короткоживущим access token. Это разлогинивало
  // пользователя посреди сессии, хотя refreshToken на устройстве был ещё
  // совершенно валиден и refreshSession() (src/api/auth.ts) могла бы его
  // продлить. Единственное место, где токены реально должны уничтожаться —
  // это refreshSession(), и только когда POST /auth/refresh САМ вернул
  // явный 401/403 (см. её комментарии). Намеренно оставлен пустым, а не
  // удалён — если понадобится настоящий retry-after-refresh на 401 для
  // обычных запросов, это отдельная фича (не в рамках этой правки): её
  // нельзя делать наивным вызовом refreshSession() отсюда, иначе для
  // самого запроса /auth/refresh (который тоже идёт через этот же
  // ApiClient) получится циклический refresh loop.
  onUnauthorized: () => {},
});

export async function primeTokenCache(): Promise<void> {
  cachedToken = await getAccessToken();
}

export function setCachedAccessToken(token: string | null): void {
  cachedToken = token;
}
