/**
 * Поддельный сервер на уровне global.fetch: настоящий ApiClient (токены, refresh, отмена) работает как в приложении.
 * Каждый запрос записывается с заголовком Authorization — тесты проверяют, чей токен ушёл с какими данными.
 */
export type SentRequest = { path: string; method: string; body?: unknown; auth: string | null };
type Reply = { status?: number; body?: unknown } | undefined;
type Handler = (req: SentRequest) => Reply | Promise<Reply>;

export const sent: SentRequest[] = [];
const holds = new Map<string, Promise<void>>();

/** Задержать ответ на `METHOD path` до вызова release() — для гонок со сменой сессии. Запрос уже отправлен. */
export function hold(key: string): () => void {
  let release!: () => void;
  holds.set(key, new Promise<void>((r) => { release = r; }));
  return () => { holds.delete(key); release(); };
}

export function installFakeServer(handler: Handler): void {
  sent.length = 0;
  holds.clear();
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body ? "<multipart>" : undefined;
    if (init.signal?.aborted) throw new Error("Aborted");
    const req: SentRequest = { path, method, body, auth: headers.Authorization ?? null };
    sent.push(req);
    const held = holds.get(`${method} ${path}`);
    if (held) {
      await new Promise<void>((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        void held.then(resolve);
      });
    }
    const reply = (await handler(req)) ?? {};
    const status = reply.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => reply.body ?? {} } as Response;
  }) as typeof fetch;
}

/** Все ли запросы, несущие данные `needle`, ушли с токеном `token` (и никакой другой). */
export const carrying = (needle: string) => sent.filter((r) => JSON.stringify(r.body ?? "").includes(needle));
