import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constants: { executionEnvironment: "storeClient" },
  loadNotifications: vi.fn(),
  permissions: vi.fn(async () => ({ status: "granted" })),
  token: vi.fn(async () => ({ data: "test-push-token" })),
  handler: vi.fn(),
  request: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: mocks.constants,
  ExecutionEnvironment: { StoreClient: "storeClient" },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../api/client", () => ({ apiClient: { request: mocks.request } }));
vi.mock("expo-notifications", () => {
  mocks.loadNotifications();
  return {
    setNotificationHandler: mocks.handler,
    getPermissionsAsync: mocks.permissions,
    getExpoPushTokenAsync: mocks.token,
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
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
