/**
 * Тонкий типизированный клиент над fetch, общий для apps/mobile и apps/admin.
 * Реальные методы (login, register, getFeed, ...) добавляются по мере
 * появления соответствующих эндпоинтов в apps/api (см. docs/api.md) — сейчас
 * зафиксирован только транспортный слой и обработка токенов/ошибок.
 */
export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken: () => string | null;
  onUnauthorized?: () => void;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.options.getAccessToken();
    const res = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });

    if (res.status === 401) {
      this.options.onUnauthorized?.();
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: ApiError } | null;
      throw new Error(body?.error?.message ?? `Request failed: ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
