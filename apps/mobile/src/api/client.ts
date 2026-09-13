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

/**
 * 2026-09-13 fix: самовосстановление после Fast Refresh (только dev).
 * Любая правка ЭТОГО файла (или чего-то, что его импортирует) заставляет
 * Metro пересоздать модуль с нуля — верхнеуровневый `cachedToken` обнуляется
 * до null, а app/_layout.tsx НЕ перемонтируется и не перезапускает свой
 * useEffect(() => primeTokenCache(), []) (пустой deps-массив выполняется
 * один раз за жизнь компонента, Fast Refresh это не считает ремонтом).
 * Результат — пользователь выглядит залогиненным (старый кэш React Query
 * ещё на экране), но ЛЮБОЙ новый запрос с авторизацией (например загрузка
 * фото в apiClient.uploadForm(), см. packages/api-client/src/index.ts) тихо
 * уходит без заголовка Authorization, потому что getAccessToken() снова
 * вернул null — backend отвечает «Missing bearer token». Раньше это
 * лечилось только полной перезагрузкой (npx expo start -c + закрыть/открыть
 * Expo Go). Строка ниже вызывается при КАЖДОЙ (пере)инициализации модуля —
 * то есть и при обычном старте приложения (безопасно дублирует вызов из
 * _layout.tsx), и при каждом Fast Refresh, который задел этот модуль — и
 * сама подтягивает токен из SecureStore, не дожидаясь ремонта RootLayout.
 */
void primeTokenCache();

/** Для сборки URL файлов, отдаваемых напрямую (не через apiClient.request), например GET /media/{id} — см. src/api/media.ts. */
export function getApiBaseUrl(): string {
  return baseUrl;
}

export function setCachedAccessToken(token: string | null): void {
  cachedToken = token;
}
