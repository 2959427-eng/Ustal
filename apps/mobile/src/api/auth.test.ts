import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@ustal/api-client";
import { apiClient, setCachedAccessToken } from "./client";
import { saveTokens, clearTokens, getRefreshToken } from "./session";
import { refreshSession, isSessionUsable, login, logout, deleteAccount } from "./auth";
import { queryClient } from "../state/query-client";

/**
 * refreshSession() (src/api/auth.ts) — 2026-09-08 fix.
 *
 * apps/mobile has no test runner set up before this file (package.json's
 * `test` script was a no-op placeholder) — vitest is added here matching
 * the convention already used by packages/ai and packages/storage
 * elsewhere in this monorepo, not jest-expo (no React Native component is
 * under test here — refreshSession()/isSessionUsable() are plain
 * functions, mocking ./client and ./session is enough, no RN renderer
 * needed).
 */

vi.mock("./client", () => ({
  apiClient: { request: vi.fn(), cancelAll: vi.fn() },
  setCachedAccessToken: vi.fn(),
}));

vi.mock("./session", () => ({
  saveTokens: vi.fn(),
  invalidateTokenWrites: vi.fn(),
  clearTokens: vi.fn(async () => {}),
  getRefreshToken: vi.fn(),
}));

vi.mock("../notifications/push", () => ({
  resetPushRegistrationState: vi.fn(),
  unregisterPush: vi.fn(async () => {}),
}));

// vi.mock() calls above are hoisted above these imports by vitest's
// transform, so these already receive the mocked modules.

it("A logout cancels pending queries and removes A data before B login", async () => {
  vi.mocked(getRefreshToken).mockResolvedValue("A-refresh");
  vi.mocked(apiClient.request).mockResolvedValue({ accessToken: "B-access", refreshToken: "B-refresh" });
  queryClient.setQueryData(["profile"], { owner: "A" });
  let finish!: (value: string) => void;
  const pending = queryClient.fetchQuery({ queryKey: ["late-A"], queryFn: () => new Promise<string>((resolve) => { finish = resolve; }) }).catch(() => null);
  await logout();
  await login("+70000000000", "test-password");
  finish("private-A"); await pending;
  expect(queryClient.getQueryData(["profile"])).toBeUndefined();
  expect(queryClient.getQueryData(["late-A"])).toBeUndefined();
});

it("SecureStore read failure is a recoverable startup result", async () => {
  vi.mocked(getRefreshToken).mockRejectedValueOnce(new Error("Keychain locked"));
  await expect(refreshSession()).resolves.toEqual({ state: "storage_unavailable" });
});

describe("refreshSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successful refresh: saves the new token pair and returns refreshed", async () => {
    vi.mocked(getRefreshToken).mockResolvedValue("old-refresh-token");
    vi.mocked(apiClient.request).mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });

    const result = await refreshSession();

    expect(result).toEqual({ state: "refreshed" });
    expect(saveTokens).toHaveBeenCalledWith("new-access", "new-refresh");
    expect(setCachedAccessToken).toHaveBeenCalledWith("new-access");
    expect(clearTokens).not.toHaveBeenCalled();
  });

  it("rotated refresh token from the backend is what gets persisted, not the old one", async () => {
    vi.mocked(getRefreshToken).mockResolvedValue("old-refresh-token");
    vi.mocked(apiClient.request).mockResolvedValue({
      accessToken: "access-2",
      refreshToken: "rotated-refresh-2",
    });

    await refreshSession();

    expect(saveTokens).toHaveBeenCalledTimes(1);
    expect(saveTokens).toHaveBeenCalledWith("access-2", "rotated-refresh-2");
    expect(saveTokens).not.toHaveBeenCalledWith(expect.anything(), "old-refresh-token");
  });

  it("rejected refresh (401 invalid_refresh_token): clears tokens and returns session_invalid", async () => {
    vi.mocked(getRefreshToken).mockResolvedValue("old-refresh-token");
    vi.mocked(apiClient.request).mockRejectedValue(
      new ApiRequestError("Сессия недействительна", 401, "invalid_refresh_token"),
    );

    const result = await refreshSession();

    expect(result).toEqual({ state: "session_invalid" });
    expect(clearTokens).toHaveBeenCalledTimes(1);
    expect(setCachedAccessToken).toHaveBeenCalledWith(null);
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it("rejected refresh (403): clears tokens and returns session_invalid", async () => {
    vi.mocked(getRefreshToken).mockResolvedValue("old-refresh-token");
    vi.mocked(apiClient.request).mockRejectedValue(new ApiRequestError("Forbidden", 403));

    const result = await refreshSession();

    expect(result).toEqual({ state: "session_invalid" });
    expect(clearTokens).toHaveBeenCalledTimes(1);
    expect(setCachedAccessToken).toHaveBeenCalledWith(null);
  });

  it("network failure (no ApiRequestError - fetch itself rejected): preserves tokens, returns network_unavailable", async () => {
    vi.mocked(getRefreshToken).mockResolvedValue("old-refresh-token");
    // fetch() rejects like this for no connectivity, DNS failure,
    // connection reset, or a timeout - none of those ever produce an
    // ApiRequestError, since that type is only constructed after an HTTP
    // response actually comes back.
    vi.mocked(apiClient.request).mockRejectedValue(new TypeError("Network request failed"));

    const result = await refreshSession();

    expect(result).toEqual({ state: "network_unavailable" });
    expect(clearTokens).not.toHaveBeenCalled();
    expect(setCachedAccessToken).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it("backend 500: preserves tokens and returns server_unavailable", async () => {
    vi.mocked(getRefreshToken).mockResolvedValue("old-refresh-token");
    vi.mocked(apiClient.request).mockRejectedValue(new ApiRequestError("Internal error", 500));

    const result = await refreshSession();

    expect(result).toEqual({ state: "server_unavailable" });
    expect(clearTokens).not.toHaveBeenCalled();
    expect(setCachedAccessToken).not.toHaveBeenCalled();
  });

  it("no local refresh token: returns no_local_session without making a network call", async () => {
    vi.mocked(getRefreshToken).mockResolvedValue(null);

    const result = await refreshSession();

    expect(result).toEqual({ state: "no_local_session" });
    expect(apiClient.request).not.toHaveBeenCalled();
    expect(clearTokens).not.toHaveBeenCalled();
  });
});

describe("isSessionUsable", () => {
  it("treats a fresh refresh as usable", () => {
    expect(isSessionUsable({ state: "refreshed" })).toBe(true);
  });

  it("treats temporary network unavailability at startup as usable - does not force a logout", () => {
    expect(isSessionUsable({ state: "network_unavailable" })).toBe(true);
  });

  it("treats temporary server unavailability at startup as usable - does not force a logout", () => {
    expect(isSessionUsable({ state: "server_unavailable" })).toBe(true);
  });

  it("treats an explicitly rejected session as not usable", () => {
    expect(isSessionUsable({ state: "session_invalid" })).toBe(false);
  });

  it("treats no local session as not usable", () => {
    expect(isSessionUsable({ state: "no_local_session" })).toBe(false);
  });
});

it("a refresh started by A cannot persist after logout and B login", async () => {
  vi.clearAllMocks();
  vi.mocked(getRefreshToken).mockResolvedValue("A-refresh");
  let resolveA!: (value: unknown) => void;
  vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }));
  const oldRefresh = refreshSession();
  await Promise.resolve();
  vi.mocked(apiClient.request).mockResolvedValue({ accessToken: "B-access", refreshToken: "B-refresh" });
  await logout();
  await login("+70000000000", "test-password");
  resolveA({ accessToken: "A-late", refreshToken: "A-late-refresh" });
  expect(await oldRefresh).toEqual({ state: "session_changed" });
  expect(saveTokens).not.toHaveBeenCalledWith("A-late", "A-late-refresh");
  expect(setCachedAccessToken).toHaveBeenLastCalledWith("B-access");
});

describe("deleteAccount (DELETE /me, 2026-10-19)", () => {
  beforeEach(() => vi.clearAllMocks());
  it("sends the password to DELETE /me and clears the local session only after success, without /auth/logout", async () => {
    vi.mocked(apiClient.request).mockResolvedValue(undefined as never);
    await deleteAccount("secret");
    expect(apiClient.request).toHaveBeenCalledTimes(1);
    expect(apiClient.request).toHaveBeenCalledWith("/me", { method: "DELETE", body: JSON.stringify({ password: "secret" }) });
    expect(clearTokens).toHaveBeenCalled();
    expect(setCachedAccessToken).toHaveBeenLastCalledWith(null);
  });
  it("a server error keeps the session (nothing cleared)", async () => {
    vi.mocked(apiClient.request).mockRejectedValue(new ApiRequestError("Неверный пароль", 403, "invalid_password"));
    await expect(deleteAccount("bad")).rejects.toBeInstanceOf(ApiRequestError);
    expect(clearTokens).not.toHaveBeenCalled();
  });
});

it("register не подставляет согласия сам: тело — ровно то, что отметил пользователь", async () => {
  const { register } = await import("./auth");
  vi.mocked(apiClient.request).mockResolvedValueOnce({ accessToken: "a", refreshToken: "r" });
  await register({ name: "Имя", phone: "+70000000000", password: "password1", cityId: "00000000-0000-4000-8000-000000000000", acceptedRules: true, acceptedPdn: true });
  const [path, init] = vi.mocked(apiClient.request).mock.calls.at(-1)!;
  expect(path).toBe("/auth/register");
  expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "Имя", phone: "+70000000000", password: "password1", cityId: "00000000-0000-4000-8000-000000000000", acceptedRules: true, acceptedPdn: true });
  // Без отметок клиент ничего не дописывает — сервер (literal true) отклонит запрос.
  vi.mocked(apiClient.request).mockResolvedValueOnce({ accessToken: "a", refreshToken: "r" });
  await register({ name: "Имя", phone: "+70000000000", password: "password1", cityId: "00000000-0000-4000-8000-000000000000" } as never);
  expect(JSON.parse(String((vi.mocked(apiClient.request).mock.calls.at(-1)![1] as RequestInit).body))).not.toHaveProperty("acceptedPdn");
});
