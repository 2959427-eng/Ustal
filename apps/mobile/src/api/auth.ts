import { apiClient, setCachedAccessToken } from "./client";
import { clearTokens, saveTokens } from "./session";
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

export async function logout(): Promise<void> {
  await clearTokens();
  setCachedAccessToken(null);
  resetPushRegistrationState();
}
