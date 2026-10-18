import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  send: vi.fn(), update: vi.fn(), insert: vi.fn(), schedule: vi.fn(), receipts: vi.fn(),
  deliveries: [] as Record<string, unknown>[],
  notification: { id: "n", userId: "A", type: "assignment", payload: { orderId: "o", title: "Test", body: "Test" } },
  device: { id: "d", userId: "A", isActive: true, expoPushToken: "token", lastSeenAt: new Date(0) },
}));
vi.mock("@ustal/notifications", () => ({ getPushProvider: () => ({ name: "expo", send: mocks.send, receipts: mocks.receipts }) }));
vi.mock("@ustal/queue", () => ({ getBoss: async () => ({ send: mocks.schedule }), JOB_TYPES: { NOTIFICATION_DISPATCH: "notification_dispatch" } }));
vi.mock("@ustal/database", async (original) => {
  const actual = await original<typeof import("@ustal/database")>();
  const db = {
    query: {
      notifications: { findFirst: async () => mocks.notification },
      users: { findFirst: async () => ({ status: "active" }) },
      deviceInstallations: { findMany: async () => [mocks.device], findFirst: async () => mocks.device },
      pushDeliveries: { findMany: async () => mocks.deliveries },
    },
    execute: async () => [],
    insert: () => ({ values: mocks.insert }),
    update: () => ({ set: (values: unknown) => ({ where: (where: unknown) => mocks.update(values, where) }) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { ...actual, getDb: () => db };
});
import { handleNotificationDispatch } from "./notification-dispatch.js";
const job = { data: { notificationId: "n" } } as Parameters<typeof handleNotificationDispatch>[0];
beforeEach(() => { vi.clearAllMocks(); mocks.send.mockResolvedValue({ ok: true, providerMessageId: "ticket", error: null }); mocks.device.userId = "A"; mocks.device.isActive = true; mocks.deliveries = []; });
it("includes orderId in push data so a tap can load canonical detail", async () => {
  await handleNotificationDispatch(job);
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ orderId: "o" }) }));
});
it("deactivates a token rejected as DeviceNotRegistered", async () => {
  mocks.send.mockResolvedValue({ ok: false, providerMessageId: null, error: "DeviceNotRegistered", invalidToken: true });
  await handleNotificationDispatch(job);
  expect(mocks.update).toHaveBeenCalledWith({ isActive: false }, expect.anything());
});

it("does not send a preloaded A job to a device now owned by B", async () => {
  mocks.device.userId = "B";
  await handleNotificationDispatch(job);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("receipt invalidation is scoped to A and to registrations older than the send", async () => {
  const sentAt = new Date("2026-09-20T00:00:00Z");
  mocks.deliveries = [{ id: "delivery", deviceInstallationId: "d", providerMessageId: "ticket", sentAt }];
  mocks.receipts.mockResolvedValue({ ticket: { ok: false, error: "DeviceNotRegistered", invalidToken: true } });
  await handleNotificationDispatch({ data: { notificationId: "n", receiptAttempt: 1 } } as typeof job);
  const [, where] = mocks.update.mock.calls.find(([values]) => values.isActive === false)!;
  const query = new PgDialect().sqlToQuery(where);
  expect(query.params).toEqual(["d", "A", sentAt.toISOString()]);
  expect(query.sql).toContain('"last_seen_at" <=');
});
