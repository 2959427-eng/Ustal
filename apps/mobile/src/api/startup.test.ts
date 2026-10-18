import { afterEach, expect, it, vi } from "vitest";
import { primeTokenCache, apiClient } from "./client";
import { refreshSession } from "./auth";
import { restoreSession } from "./startup";
vi.mock("./client", () => ({ primeTokenCache: vi.fn(), apiClient: { cancelAll: vi.fn() } }));
vi.mock("./auth", () => ({ refreshSession: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it("turns locked SecureStore into a retryable startup state", async () => {
  vi.mocked(primeTokenCache).mockRejectedValueOnce(new Error("locked"));
  expect(await restoreSession()).toEqual({ state: "storage_unavailable" });
});
it("bounds startup even when a native dependency never settles", async () => {
  vi.useFakeTimers(); vi.mocked(primeTokenCache).mockImplementation(() => new Promise(() => {}));
  const pending = restoreSession(); await vi.advanceTimersByTimeAsync(35_001);
  expect(await pending).toEqual({ state: "storage_unavailable" });
  expect(apiClient.cancelAll).toHaveBeenCalled();
});
it.each(["network_unavailable", "server_unavailable", "session_invalid", "no_local_session"] as const)("preserves the refresh decision: %s", async (state) => {
  vi.mocked(primeTokenCache).mockResolvedValueOnce(); vi.mocked(refreshSession).mockResolvedValueOnce({ state });
  expect(await restoreSession()).toEqual({ state });
});
