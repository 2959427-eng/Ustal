import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiSessionChangedError } from "@ustal/api-client";

/** Общий ApiClient: запрос сессии A никогда не уходит с токеном B (2026-10-27). */
const ok = (body: unknown = {}) => ({ status: 200, ok: true, json: async () => body }) as Response;
function setup(opts: { load?: () => Promise<string | null>; refresh?: () => Promise<boolean> } = {}) {
  let token: string | null = "A-access";
  const sent: { path: string; auth: string | null }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ path: url.replace("http://t", ""), auth: (init.headers as Record<string, string> | undefined)?.Authorization ?? null });
    if (init.signal?.aborted) throw new Error("Aborted");
    return ok();
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new ApiClient({ baseUrl: "http://t", getAccessToken: () => token, loadAccessToken: opts.load, refreshAccessToken: opts.refresh });
  /** Как isolateSession + login B: отмена всего, затем токен B. */
  const switchToB = () => { client.cancelAll(); token = "B-access"; };
  return { client, sent, switchToB, setToken: (t: string | null) => { token = t; } };
}

describe("ApiClient: привязка запросов к сессии", () => {
  it("запрос с номером прежней сессии не отправляется вообще (ни с каким токеном)", async () => {
    const { client, sent, switchToB } = setup();
    const a = client.currentSession();
    switchToB();
    await expect(client.request("/orders", { method: "POST", body: "{}", session: a })).rejects.toBeInstanceOf(ApiSessionChangedError);
    await expect(client.uploadForm("/media", new FormData(), a)).rejects.toBeInstanceOf(ApiSessionChangedError);
    expect(sent).toEqual([]);
    await client.request("/orders", { method: "POST", body: "{}", session: client.currentSession() });
    expect(sent).toEqual([{ path: "/orders", auth: "Bearer B-access" }]);
  });

  it("токен A не в памяти: пока он подгружается, сессия сменилась на B — запрос не уходит с токеном B", async () => {
    let finishLoad!: () => void;
    const h = setup({ load: () => new Promise((r) => { finishLoad = () => r(null); }) });
    h.setToken(null);
    const pending = h.client.request("/profile/inputs", { method: "POST", body: "{}", session: h.client.currentSession() });
    h.switchToB();
    finishLoad();
    await expect(pending).rejects.toThrow();
    expect(h.sent).toEqual([]);
  });

  it("401 → refresh; во время refresh вошёл B — повтор с токеном B не отправляется", async () => {
    let finishRefresh!: (v: boolean) => void;
    const h = setup({ refresh: () => new Promise((r) => { finishRefresh = r; }) });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      h.sent.push({ path: url.replace("http://t", ""), auth: (init.headers as Record<string, string>).Authorization ?? null });
      return { status: 401, ok: false, json: async () => ({ error: { code: "unauthorized" } }) } as Response;
    }));
    const pending = h.client.request("/orders", { method: "POST", body: "{}", session: h.client.currentSession() });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.switchToB();
    finishRefresh(true);
    await expect(pending).rejects.toThrow();
    expect(h.sent).toEqual([{ path: "/orders", auth: "Bearer A-access" }]);
  });

  it("без номера сессии поведение прежнее (админка и прочие запросы)", async () => {
    const { client, sent } = setup();
    await client.request("/x");
    expect(sent).toEqual([{ path: "/x", auth: "Bearer A-access" }]);
  });
});
