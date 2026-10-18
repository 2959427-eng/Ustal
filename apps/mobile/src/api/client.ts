import Constants from "expo-constants";
import { router } from "expo-router";
import { ApiClient } from "@ustal/api-client";
import { getAccessToken } from "./session";
import { productionApiUrl } from "../../config/api-url";

const configuredUrl = Constants.expoConfig?.extra?.apiBaseUrl as string | undefined;
const baseUrl = !__DEV__ || Constants.expoConfig?.extra?.release
  ? productionApiUrl(configuredUrl)
  : configuredUrl ?? "http://localhost:4000";

// Кэш access token хранится в globalThis, а не в переменной модуля: при Fast Refresh/повторной
// инициализации client.ts переменная модуля обнулялась (или у разных экземпляров модуля она была своя),
// и запросы уходили без Authorization — «Missing bearer token», хотя пользователь вошёл.
const tokenStore = globalThis as { __ustalAccessToken?: string | null };
const readCachedToken = (): string | null => tokenStore.__ustalAccessToken ?? null;
let tokenRevision = 0;

export const apiClient = new ApiClient({
  baseUrl,
  getAccessToken: readCachedToken,
  // Кэш пуст, а токен в SecureStore есть — подтягиваем его до отправки запроса.
  loadAccessToken: async () => {
    await primeTokenCache();
    return readCachedToken();
  },
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
  // Аккаунт заблокирован админом (403 account_blocked): выходим из сессии и возвращаем на онбординг.
  onAccountBlocked: () => {
    void (async () => {
      const { expireLocalSession } = await import("./auth");
      await expireLocalSession();
      router.replace("/onboarding");
    })();
  },
  // Access token живёт ACCESS_TOKEN_TTL_MINUTES (15 мин), а refreshSession() раньше вызывалась
  // только при старте приложения — после истечения ЛЮБОЙ запрос (в т.ч. загрузка аватарки,
  // POST /media) получал 401 и AvatarPicker показывал «Сессия истекла». Теперь на 401 клиент
  // сам обновляет токен (единая refreshSession, rotating refresh) и повторяет запрос один раз.
  // Динамический import — чтобы не создавать цикл client.ts <-> auth.ts на этапе загрузки модулей.
  refreshAccessToken: async () => {
    const { refreshSession } = await import("./auth");
    const result = await refreshSession();
    if (result.state === "session_invalid" || result.state === "no_local_session") router.replace("/onboarding");
    return result.state === "refreshed";
  },
});

export async function primeTokenCache(): Promise<void> {
  const revision = tokenRevision;
  const stored = await getAccessToken();
  // Не затираем токен, который логин/refresh уже успел положить, пока шло чтение из хранилища.
  if (revision === tokenRevision && readCachedToken() === null) tokenStore.__ustalAccessToken = stored;
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
void primeTokenCache().catch(() => {});

/** Для сборки URL файлов, отдаваемых напрямую (не через apiClient.request), например GET /media/{id} — см. src/api/media.ts. */
export function getApiBaseUrl(): string {
  return baseUrl;
}

export function setCachedAccessToken(token: string | null): void {
  tokenRevision += 1;
  tokenStore.__ustalAccessToken = token;
}
