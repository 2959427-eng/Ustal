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
  /** Сервер ответил 403 account_blocked (аккаунт заблокирован админом): клиент должен выйти из сессии. */
  onAccountBlocked?: () => void;
  /**
   * Обновляет access token (rotating refresh) и возвращает true, если новый токен
   * уже доступен через getAccessToken(). Вызывается ОДИН РАЗ на пачку параллельных
   * 401 и не вызывается для путей /auth/* (иначе сам refresh/login зациклился бы).
   * После успеха неудавшийся запрос (включая multipart-загрузку) повторяется один раз.
   */
  refreshAccessToken?: () => Promise<boolean>;
  /**
   * Подгружает access token из постоянного хранилища, если в памяти его нет (getAccessToken() === null).
   * Нужен, чтобы запрос не уходил без Authorization («Missing bearer token»), когда кэш в памяти
   * сброшен (Fast Refresh, повторная инициализация модуля), а токен в хранилище есть.
   */
  loadAccessToken?: () => Promise<string | null>;
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
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly options: ApiClientOptions) {}

  /** Единый refresh на все одновременные 401: refresh-токен одноразовый, второй параллельный refresh его бы сжёг. */
  private refreshOnce(): Promise<boolean> {
    const refresh = this.options.refreshAccessToken;
    if (!refresh) return Promise.resolve(false);
    if (!this.refreshing) {
      this.refreshing = refresh()
        .catch(() => false)
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  /**
   * fetch с авторизацией: на 401 (кроме /auth/*) обновляет access token и повторяет запрос
   * один раз. Общий для request() и uploadForm() — раньше multipart-загрузка (аватарка, фото)
   * не имела никакого восстановления и на просроченном access token (TTL 15 мин) сразу
   * показывала «Сессия истекла».
   */
  private async fetchAuthed(path: string, makeInit: (token: string | null) => RequestInit): Promise<Response> {
    const url = `${this.options.baseUrl}${path}`;
    let sentToken = this.options.getAccessToken();
    if (sentToken === null && this.options.loadAccessToken) {
      await this.options.loadAccessToken().catch(() => null);
      sentToken = this.options.getAccessToken();
    }
    let res = await fetch(url, makeInit(sentToken));
    if (res.status !== 401 || path.startsWith("/auth/")) return res;

    // Токен уже мог быть обновлён параллельным запросом — тогда достаточно повторить.
    const current = this.options.getAccessToken();
    const haveFresh = current !== null && current !== sentToken ? true : await this.refreshOnce();
    if (haveFresh) res = await fetch(url, makeInit(this.options.getAccessToken()));
    return res;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchAuthed(path, (token) => ({
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    }));

    if (res.status === 401) {
      this.options.onUnauthorized?.();
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: ApiError } | null;
      if (res.status === 403 && body?.error?.code === "account_blocked" && !path.startsWith("/auth/")) {
        this.options.onAccountBlocked?.();
      }
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
    const res = await this.fetchAuthed(path, (token) => ({
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    }));

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
