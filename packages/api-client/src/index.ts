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

/**
 * Ошибка неуспешного запроса — сохраняет HTTP-статус и код ошибки сервера
 * (docs/api.md: `{ error: { code, message } }`), а не только текст. Нужно,
 * например, чтобы на экране заказа (apps/mobile/app/order/[id].tsx) отличить
 * 404 «не автор этого заказа» (штатный fallback на вид кандидата) от прочих
 * ошибок — раньше обе выглядели как одинаковый `Error` без статуса.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
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
      throw new ApiRequestError(body?.error?.message ?? `Request failed: ${res.status}`, res.status, body?.error?.code);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Multipart-запрос (сейчас единственный потребитель — `POST /media`,
   * apps/mobile/src/api/media.ts) — не через `request<T>`, потому что тот
   * всегда шлёт `Content-Type: application/json`. Boundary для
   * `multipart/form-data` должен выставить сам `fetch`/полифилл `FormData`
   * по телу запроса, поэтому здесь `Content-Type` не задаётся вручную.
   */
  async uploadForm<T>(path: string, form: FormData): Promise<T> {
    const token = this.options.getAccessToken();
    const res = await fetch(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });

    if (res.status === 401) {
      this.options.onUnauthorized?.();
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: ApiError } | null;
      throw new ApiRequestError(body?.error?.message ?? `Request failed: ${res.status}`, res.status, body?.error?.code);
    }
    return (await res.json()) as T;
  }
}
