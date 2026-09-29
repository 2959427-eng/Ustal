import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ values: new Map<string, string>(), set: vi.fn(), remove: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => mocks.values.get(key) ?? null,
  setItemAsync: mocks.set,
  deleteItemAsync: mocks.remove,
}));
afterEach(() => { vi.useRealTimers(); vi.resetModules(); mocks.values.clear(); vi.resetAllMocks(); });
it("serializes a late native A write before logout and B, preventing credential resurrection", async () => {
  let completeA!: () => void;
  mocks.set.mockImplementationOnce((key: string, value: string) => new Promise<void>((resolve) => {
    completeA = () => { mocks.values.set(key, value); resolve(); };
  })).mockImplementation(async (key: string, value: string) => { mocks.values.set(key, value); });
  mocks.remove.mockImplementation(async (key: string) => { mocks.values.delete(key); });
  const session = await import("./session");
  const a = session.saveTokens("A-access", "A-refresh");
  await Promise.resolve();
  const logout = session.clearTokens();
  const b = session.saveTokens("B-access", "B-refresh");
  completeA(); await Promise.all([a, logout, b]);
  expect(await session.getAccessToken()).toBe("B-access");
  expect(await session.getRefreshToken()).toBe("B-refresh");
});
it("reads pre-release legacy credentials and removes all formats on logout", async () => {
  mocks.values.set("ustal.accessToken", "legacy-access"); mocks.values.set("ustal.refreshToken", "legacy-refresh");
  mocks.remove.mockImplementation(async (key: string) => { mocks.values.delete(key); });
  const session = await import("./session");
  expect(await session.getAccessToken()).toBe("legacy-access");
  await session.clearTokens();
  expect(await session.getRefreshToken()).toBeNull();
});
