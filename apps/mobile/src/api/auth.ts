import { ApiRequestError } from "@ustal/api-client";
import { apiClient, setCachedAccessToken } from "./client";
import { clearTokens, getRefreshToken, saveTokens, invalidateTokenWrites } from "./session";
import { clearUserQueries } from "../state/query-client";
import { resetPushRegistrationState, unregisterPush } from "../notifications/push";

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
  // true — сервер предлагает подтвердить номер (PHONE_VERIFICATION_MODE != disabled и
  // телефон ещё не подтверждён). Необязательное поле: отсутствует, пока фича выключена
  // на бэкенде (значение по умолчанию). Ничего не блокирует — просто сигнал для UI.
  phoneVerificationSuggested?: boolean;
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

export interface LoginResult {
  // Пробрасываем наружу, чтобы будущий экран «подтвердите телефон» подключался без
  // изменения сигнатуры login() — сейчас всегда false, пока фича выключена на бэкенде.
  phoneVerificationSuggested: boolean;
}

let sessionGeneration = 0;
let refreshInFlight: Promise<RefreshSessionResult> | null = null;

async function isolateSession() {
  sessionGeneration += 1;
  invalidateTokenWrites();
  refreshInFlight = null;
  apiClient.cancelAll();
  await clearUserQueries();
}

/** Server has already rejected/blocked the session; never recursively call logout endpoints. */
export async function expireLocalSession(): Promise<void> {
  await isolateSession();
  setCachedAccessToken(null);
  resetPushRegistrationState();
  await clearTokens().catch(() => {});
  setCachedAccessToken(null);
}

export async function login(phone: string, password: string): Promise<LoginResult> {
  await isolateSession();
  const generation = sessionGeneration;
  const res = await apiClient.request<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone, password }),
  });
  if (generation !== sessionGeneration) throw new Error("Session changed");
  await saveTokens(res.accessToken, res.refreshToken);
  if (generation !== sessionGeneration) throw new Error("Session changed");
  setCachedAccessToken(res.accessToken);
  return { phoneVerificationSuggested: res.phoneVerificationSuggested ?? false };
}

export interface RegisterPayload {
  name: string;
  phone: string;
  password: string;
  cityId: string;
  acceptedAge18: true;
  acceptedRules: true;
  acceptedPdn: true;
  // Заполняется только когда бэкенд включит обязательное подтверждение для новых
  // регистраций (POST /auth/otp/verify → phoneVerificationToken). Пока фича выключена,
  // поле не передаётся, и сервер его игнорирует.
  phoneVerificationToken?: string;
}

export async function register(payload: RegisterPayload): Promise<void> {
  if (payload.acceptedAge18 !== true) throw new Error("Подтвердите, что вам исполнилось 18 лет");
  if (payload.acceptedRules !== true || payload.acceptedPdn !== true) throw new Error("Подтвердите ознакомление с условиями и обработкой данных");
  await isolateSession();
  const generation = sessionGeneration;
  const res = await apiClient.request<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (generation !== sessionGeneration) throw new Error("Session changed");
  await saveTokens(res.accessToken, res.refreshToken);
  if (generation !== sessionGeneration) throw new Error("Session changed");
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
  | "server_unavailable"
  | "storage_unavailable"
  | "session_changed";

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
export function refreshSession(): Promise<RefreshSessionResult> {
  if (!refreshInFlight) {
    const task = refreshCurrentSession().finally(() => { if (refreshInFlight === task) refreshInFlight = null; });
    refreshInFlight = task;
  }
  return refreshInFlight;
}

async function refreshCurrentSession(): Promise<RefreshSessionResult> {
  const generation = sessionGeneration;
  let refreshToken: string | null;
  try { refreshToken = await getRefreshToken(); }
  catch { return { state: "storage_unavailable" }; }
  if (generation !== sessionGeneration) return { state: "session_changed" };
  if (!refreshToken) return { state: "no_local_session" };

  try {
    const res = await apiClient.request<RefreshResponse>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    // Rotating refresh: сервер уже отозвал старый refreshToken и выдал
    // новый вместе с access token — сохраняем оба, старый больше ни на
    // что не годен.
    if (generation !== sessionGeneration) throw new Error("Session changed");
    try { await saveTokens(res.accessToken, res.refreshToken); } catch { return { state: "storage_unavailable" }; }
    if (generation !== sessionGeneration) return { state: "session_changed" };
    setCachedAccessToken(res.accessToken);
    return { state: "refreshed" };
  } catch (err) {
    if (generation !== sessionGeneration) return { state: "session_changed" };
    if (err instanceof ApiRequestError) {
      if (err.status === 401 || err.status === 403) {
        // Backend явно отклонил refreshToken — единственный случай,
        // когда сессию действительно нужно уничтожить локально.
        await expireLocalSession();
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

/** A successful logout includes server acknowledgement of push detachment.
 * Offline detachment is retriable; do not silently allow a switch to B while A owns the device.
 */
export async function logout(): Promise<void> {
  await isolateSession();
  await unregisterPush();
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    try {
      await apiClient.request("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) });
    } catch { /* Push is already detached. Always complete local token removal. */ }
  }
  await isolateSession();
  setCachedAccessToken(null);
  await clearTokens();
  setCachedAccessToken(null);
  resetPushRegistrationState();
}

/**
 * Удаление аккаунта (DELETE /me, 2026-10-19). Пароль ещё раз. После успеха сервер уже удалил сессии и
 * устройства, поэтому локально только изолируем сессию и стираем токены (expireLocalSession), без /auth/logout.
 * Повтор после потерянного ответа получит 401 — это тоже «аккаунта больше нет»: сессия очищается так же.
 */
export async function deleteAccount(password: string): Promise<void> {
  await apiClient.request("/me", { method: "DELETE", body: JSON.stringify({ password }) });
  await expireLocalSession();
}
