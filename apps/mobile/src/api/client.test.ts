import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiRequestError } from "@ustal/api-client";

/**
 * 401 -> refresh -> retry в общем ApiClient (request() и multipart uploadForm()).
 * Регрессия: загрузка аватарки (POST /media) на просроченном access token сразу
 * показывала «Сессия истекла», потому что refresh вызывался только при старте приложения.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function authOf(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit;
  return (init.headers as Record<string, string> | undefined)?.Authorization;
}

describe("ApiClient: refresh on 401", () => {
  let token: string | null;
  const fetchMock = vi.fn();

  beforeEach(() => {
    token = "expired";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeClient = (refresh?: () => Promise<boolean>) =>
    new ApiClient({ baseUrl: "http://api", getAccessToken: () => token, refreshAccessToken: refresh });

  it("uploadForm: expired token -> refresh once -> retries with the new token and succeeds", async () => {
    const refresh = vi.fn(async () => {
      token = "fresh";
      return true;
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "unauthorized", message: "Invalid or expired token" } }))
      .mockResolvedValueOnce(jsonResponse(201, { mediaId: "m1" }));

    const res = await makeClient(refresh).uploadForm<{ mediaId: string }>("/media", new FormData());

    expect(res).toEqual({ mediaId: "m1" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authOf(fetchMock.mock.calls[0]!)).toBe("Bearer expired");
    expect(authOf(fetchMock.mock.calls[1]!)).toBe("Bearer fresh");
  });

  it("request: 401 -> refresh -> retry succeeds", async () => {
    const refresh = vi.fn(async () => {
      token = "fresh";
      return true;
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {})).mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    await expect(makeClient(refresh).request("/me")).resolves.toEqual({ ok: 1 });
    expect(authOf(fetchMock.mock.calls[1]!)).toBe("Bearer fresh");
  });

  it("parallel 401s share a single refresh (refresh token is single-use)", async () => {
    const refresh = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      token = "fresh";
      return true;
    });
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === "Bearer fresh" ? jsonResponse(200, { ok: 1 }) : jsonResponse(401, {}),
    );
    const client = makeClient(refresh);
    await Promise.all([client.request("/a"), client.request("/b"), client.uploadForm("/media", new FormData())]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refresh failed -> original 401 is thrown, no retry", async () => {
    const refresh = vi.fn(async () => false);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: "unauthorized", message: "Invalid or expired token" } }));
    const err = await makeClient(refresh).uploadForm("/media", new FormData()).catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refresh that throws is treated as failed refresh", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("network");
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    await expect(makeClient(refresh).request("/me")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never refreshes for /auth/* (no refresh loop, wrong password stays 401)", async () => {
    const refresh = vi.fn(async () => true);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: "invalid_credentials", message: "x" } }));
    await expect(makeClient(refresh).request("/auth/login", { method: "POST" })).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("non-401 upload errors are not treated as session problems and do not refresh", async () => {
    const refresh = vi.fn(async () => true);
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { code: "invalid_mime_type", message: "bad" } }));
    await expect(makeClient(refresh).uploadForm("/media", new FormData())).rejects.toMatchObject({ status: 400, code: "invalid_mime_type" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("no token in memory: loads it from storage before the first request (no 'Missing bearer token')", async () => {
    token = null;
    const load = vi.fn(async () => {
      token = "from-storage";
      return token;
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    const client = new ApiClient({ baseUrl: "http://api", getAccessToken: () => token, loadAccessToken: load });
    await expect(client.uploadForm("/media", new FormData())).resolves.toEqual({ ok: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(authOf(fetchMock.mock.calls[0]!)).toBe("Bearer from-storage");
  });

  it("token present: loadAccessToken is not called", async () => {
    const load = vi.fn(async () => "x");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    await new ApiClient({ baseUrl: "http://api", getAccessToken: () => token, loadAccessToken: load }).request("/me");
    expect(load).not.toHaveBeenCalled();
  });

  it("without refreshAccessToken behaves as before (401 thrown)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    await expect(makeClient().request("/me")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
