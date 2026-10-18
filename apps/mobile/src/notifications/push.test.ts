import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constants: { executionEnvironment: "storeClient", expoConfig: { extra: { eas: { projectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } } } },
  loadNotifications: vi.fn(),
  permissions: vi.fn(async () => ({ status: "granted" })),
  token: vi.fn(async () => ({ data: "test-push-token" })),
  handler: vi.fn(),
  request: vi.fn(),
  stored: new Map<string, string>(),
}));

vi.mock("expo-constants", () => ({
  default: mocks.constants,
  ExecutionEnvironment: { StoreClient: "storeClient" },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../api/client", () => ({ apiClient: { request: mocks.request } }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => mocks.stored.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { mocks.stored.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { mocks.stored.delete(key); }),
}));
vi.mock("expo-notifications", () => {
  mocks.loadNotifications();
  return {
    setNotificationHandler: mocks.handler,
    setNotificationChannelAsync: vi.fn(async () => {}),
    AndroidImportance: { HIGH: 4 },
    getPermissionsAsync: mocks.permissions,
    getExpoPushTokenAsync: mocks.token,
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.stored.clear();
  mocks.request.mockResolvedValue({});
});

it("A registration -> logout detach -> B registration even with the same Expo token", async () => {
  mocks.constants.executionEnvironment = "standalone";
  const push = await import("./push");
  await push.ensurePushRegistered();
  expect(push).toHaveProperty("unregisterPush");
  await (push as unknown as { unregisterPush(): Promise<void> }).unregisterPush();
  push.resetPushRegistrationState();
  await push.ensurePushRegistered();
  expect(mocks.request.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "DELETE", "POST"]);
});

it("does not evaluate notifications or register a device in Android Expo Go", async () => {
  mocks.constants.executionEnvironment = "storeClient";
  const { ensurePushRegistered } = await import("./push");
  await ensurePushRegistered();
  expect(mocks.loadNotifications).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});

it("registers push and installs the foreground handler in a standalone build", async () => {
  mocks.constants.executionEnvironment = "standalone";
  const { ensurePushRegistered } = await import("./push");
  await ensurePushRegistered();
  expect(mocks.handler).toHaveBeenCalledOnce();
  expect(mocks.request).toHaveBeenCalledWith("/devices", {
    method: "POST",
    body: JSON.stringify({ expoPushToken: "test-push-token", platform: "android" }),
  });
});

it("keeps the persisted token when offline detachment fails, allowing retry after restart", async () => {
  mocks.stored.set("ustal.pushToken", "old-token");
  mocks.request.mockRejectedValueOnce(new Error("offline"));
  const push = await import("./push");
  await expect(push.unregisterPush()).rejects.toThrow("offline");
  expect(mocks.stored.get("ustal.pushToken")).toBe("old-token");
  await push.unregisterPush();
  expect(mocks.stored.has("ustal.pushToken")).toBe(false);
  expect(mocks.request).toHaveBeenLastCalledWith("/devices", { method: "DELETE", body: JSON.stringify({ expoPushToken: "old-token", platform: "android" }) });
});
