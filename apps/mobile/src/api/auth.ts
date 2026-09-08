import { ApiRequestError } from "@ustal/api-client";
import { apiClient, setCachedAccessToken } from "./client";
import { clearTokens, getRefreshToken, saveTokens } from "./session";
import { resetPushRegistrationState } from "../notifications/push";

/**
 * Реальные вызовы POST /auth/login и /auth/register (Фаза 2, docs/api.md).
 * Раньше экраны входа/регистрации были только UI-заглушками Фазы 1
 * (см. history) — этот модуль впервые подключает мобильное приложение к
 * уже давно готовому и проверенному backend'у.
 */
interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/**
 * POST /auth/refresh не возвращает userId — только новую пару токенов
 * (rotating refresh: старый refreshToken отзывается сервером сразу же,
 * см. apps/api/src/routes/auth.ts).
 */
interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export async function login(phone: string, password: string): Promise<void> {
  const res = await apiClient.request<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone, password }),
  });
  await saveTokens(res.accessToken, res.refreshToken);
  setCachedAccessToken(res.accessToken);
}

export interface RegisterPayload {
  name: string;
  phone: string;
  password: string;
  cityId: string;
}

export async function register(payload: RegisterPayload): Promise<void> {
  // acceptedRules/acceptedPdn — в MVP нет отдельного экрана согласий
  // (раздел 5 ТЗ такого не требует отдельно от факта регистрации), поэтому
  // сам факт отправки формы регистрации и есть согласие; бэкенд требует
  // оба поля буквально true (packages/validation/src/auth.ts).
  const res = await apiClient.request<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...payload, acceptedRules: true, acceptedPdn: true }),
  });
  await saveTokens(res.accessToken, res.refreshToken);
  setCachedAccessToken(res.accessToken);
}

/**
 * Состояния результата refreshSession() (2026-09-08, см. историю правки
 * ниже перед самой функцией):
 *
 * - "refreshed" — POST /auth/refresh успешно вернул новую пару токенов,
 *   сохранены в SecureStore и закешированы для ApiClient.
 * - "no_local_session" — на устройстве вообще нет refreshToken (чистая
 *   установка или после logout) — сетевой вызов не делается вообще.
 * - "session_invalid" — backend ЯВНО отклонил refreshToken: HTTP 401 или
 *   403 (см. apps/api/src/routes/auth.ts — `invalid_refresh_token`:
 *   токен истёк/отозван/пользователь заблокирован). ЕДИНСТВЕННЫЕ случаи,
 *   в которых локальные токены реально уничтожаются.
 * - "network_unavailable" — запрос вообще не дошёл до сервера (нет сети,
 *   DNS-сбой, connection reset, таймаут) — это НЕ ApiRequestError (тот
 *   бросается только после получения HTTP-ответа), а обычная ошибка
 *   fetch(). Токены НЕ трогаются.
 * - "server_unavailable" — backend ответил, но не 401/403 (в первую
 *   очередь 5xx, а также любой другой код, который мы не распознаём как
 *   явный отказ) — временная проблема на стороне сервера, не отказ сессии.
 *   Токены НЕ трогаются.
 *
 * Используйте isSessionUsable() ниже, чтобы решить, пускать ли
 * пользователя дальше в приложение — она обрабатывает три из пяти
 * состояний как "сессия всё ещё годная" (refreshed и оба временных
 * состояния), а не только "refreshed".
 */
export type RefreshSessionState =
  | "refreshed"
  | "no_local_session"
  | "session_invalid"
  | "network_unavailable"
  | "server_unavailable";

export interface RefreshSessionResult {
  state: RefreshSessionState;
}

/**
 * Восстановление/продление сессии через rotating refresh token
 * (POST /auth/refresh, docs/architecture.md).
 *
 * 2026-09-08 fix: раньше ЛЮБАЯ ошибка (включая сетевой сбой/таймаут/DNS/
 * 5xx backend'а) приводила к clearTokens() — то есть временная
 * недоступность API молча разлогинивала пользователя, хотя refreshToken
 * на устройстве был совершенно валиден. Теперь токены уничтожаются ТОЛЬКО
 * если backend явно ответил 401/403 (см. RefreshSessionState выше) —
 * любая другая ошибка считается временной, токены сохраняются, вызывающий
 * код может повторить попытку позже.
 */
export async function refreshSession(): Promise<RefreshSessionResult> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return { state: "no_local_session" };

  try {
    const res = await apiClient.request<RefreshResponse>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    // Rotating refresh: сервер уже отозвал старый refreshToken и выдал
    // новый вместе с access token — сохраняем оба, старый больше ни на
    // что не годен.
    await saveTokens(res.accessToken, res.refreshToken);
    setCachedAccessToken(res.accessToken);
    return { state: "refreshed" };
  } catch (err) {
    if (err instanceof ApiRequestError) {
      if (err.status === 401 || err.status === 403) {
        // Backend явно отклонил refreshToken — единственный случай,
        // когда сессию действительно нужно уничтожить локально.
        await clearTokens();
        setCachedAccessToken(null);
        return { state: "session_invalid" };
      }
      // Любой другой HTTP-статус (в первую очередь 5xx) — сервер ответил,
      // но это не отказ сессии, а его собственная временная проблема.
      // Токены сохраняются.
      return { state: "server_unavailable" };
    }
    // Не ApiRequestError значит запрос вообще не получил HTTP-ответ — нет
    // сети, DNS-сбой, connection reset или таймаут fetch() ведут себя
    // одинаково с точки зрения этого catch. Токены сохраняются.
    return { state: "network_unavailable" };
  }
}

/**
 * Решает, можно ли считать пользователя всё ещё вошедшим по результату
 * refreshSession() — используется в app/_layout.tsx при старте
 * приложения. Явный список "годных" состояний (а не "всё, кроме
 * session_invalid"), чтобы новое состояние, добавленное в будущем в
 * RefreshSessionState, по умолчанию считалось НЕ годным, а не наоборот.
 *
 * "refreshed" — очевидно годно. "network_unavailable"/"server_unavailable"
 * — тоже годно: локальные токены не были тронуты (см. refreshSession()),
 * а старт приложения не должен разлогинивать пользователя только из-за
 * временно недоступного API. Только "session_invalid" (сервер явно
 * отклонил токен) и "no_local_session" (нечего восстанавливать) означают
 * реальный переход на экран входа.
 */
export function isSessionUsable(result: RefreshSessionResult): boolean {
  return (
    result.state === "refreshed" ||
    result.state === "network_unavailable" ||
    result.state === "server_unavailable"
  );
}

export async function logout(): Promise<void> {
  // Best-effort отзыв сессии на сервере (POST /auth/logout, requires
  // Authorization — вызываем ДО очистки локальных токенов). Раньше logout()
  // был чисто локальным: SecureStore чистился, но refreshToken на сервере
  // оставался живым до истечения REFRESH_TOKEN_TTL_DAYS — не дыра (токен
  // никому больше не известен), но и не настоящий logout серверной сессии.
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    try {
      await apiClient.request("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // Сеть недоступна / токен уже недействителен — не блокирует локальный
      // логаут, который ниже выполняется в любом случае. Logout — явное
      // действие пользователя, здесь как раз правильно всегда чистить
      // локально независимо от результата сетевого вызова (в отличие от
      // refreshSession() выше, где сессия не должна теряться сама по себе).
    }
  }
  await clearTokens();
  setCachedAccessToken(null);
  resetPushRegistrationState();
}
