import type PgBoss from "pg-boss";
import { and, eq, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getPushProvider } from "@ustal/notifications";
import { getBoss, JOB_TYPES } from "@ustal/queue";

export interface NotificationDispatchJobData { notificationId: string; receiptAttempt?: number }

async function scheduleReceipts(notificationId: string, attempt: number) {
  const boss = await getBoss();
  await boss.send(JOB_TYPES.NOTIFICATION_DISPATCH, { notificationId, receiptAttempt: attempt }, { startAfter: 15 * 60, retryLimit: 3, retryDelay: 60 });
}

export async function handleNotificationDispatch(job: PgBoss.Job<NotificationDispatchJobData>) {
  const db = getDb();
  const provider = getPushProvider();
  const notification = await db.query.notifications.findFirst({ where: eq(schema.notifications.id, job.data.notificationId) });
  if (!notification) return { sent: 0, failed: 0 };
  if (job.data.receiptAttempt) {
    if (!provider.receipts) return { checked: 0 };
    const deliveries = await db.query.pushDeliveries.findMany({ where: and(eq(schema.pushDeliveries.notificationId, notification.id), eq(schema.pushDeliveries.status, "accepted")) });
    let pending = false;
    // Expo accepts at most 1000 receipts per request; use small bounded batches.
    for (let i = 0; i < deliveries.length; i += 100) {
      const batch = deliveries.slice(i, i + 100);
      const receipts = await provider.receipts(batch.flatMap((d) => d.providerMessageId ? [d.providerMessageId] : []));
      for (const delivery of batch) {
        const receipt = delivery.providerMessageId ? receipts[delivery.providerMessageId] : undefined;
        if (!receipt && job.data.receiptAttempt < 4) { pending = true; continue; }
        await db.update(schema.pushDeliveries).set({ status: receipt?.ok ? "sent" : "failed", error: receipt?.error ?? (receipt ? null : "ReceiptUnavailable") }).where(eq(schema.pushDeliveries.id, delivery.id));
        if (receipt?.invalidToken && delivery.sentAt) {
          // A receipt for A must never disable the same installation after B re-registers it.
          await db.update(schema.deviceInstallations).set({ isActive: false }).where(and(
            eq(schema.deviceInstallations.id, delivery.deviceInstallationId), eq(schema.deviceInstallations.userId, notification.userId), lte(schema.deviceInstallations.lastSeenAt, delivery.sentAt),
          ));
        }
      }
    }
    if (pending) await scheduleReceipts(notification.id, job.data.receiptAttempt + 1);
    return { checked: deliveries.length };
  }
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, notification.userId) });
  if (user?.status !== "active") return { sent: 0, failed: 0 };
  const devices = await db.query.deviceInstallations.findMany({ where: and(eq(schema.deviceInstallations.userId, notification.userId), eq(schema.deviceInstallations.isActive, true)) });
  const payload = notification.payload as { title?: string; body?: string; orderId?: string };
  let sent = 0, failed = 0, accepted = 0;
  for (const device of devices) {
    // Serializes sends with DELETE/upsert on this device row. Once detachment
    // is acknowledged, no new send can use A's stale preloaded device list.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM device_installations WHERE id=${device.id} FOR UPDATE`);
      const current = await tx.query.deviceInstallations.findFirst({ where: eq(schema.deviceInstallations.id, device.id) });
      if (!current?.isActive || current.userId !== notification.userId || current.expoPushToken !== device.expoPushToken) return;
      const result = await provider.send({ expoPushToken: current.expoPushToken, title: payload.title ?? "USTAL", body: payload.body ?? "У вас новое уведомление",
        data: { notificationId: notification.id, type: notification.type, ...(payload.orderId ? { orderId: payload.orderId } : {}) },
      });
      const awaitsReceipt = result.ok && provider.receipts && result.providerMessageId;
      if (awaitsReceipt) accepted += 1;
      else if (result.ok) sent += 1;
      else failed += 1;
      await tx.insert(schema.pushDeliveries).values({ notificationId: notification.id, deviceInstallationId: device.id,
        status: awaitsReceipt ? "accepted" : result.ok ? "sent" : "failed", providerMessageId: result.providerMessageId, sentAt: result.ok ? new Date() : null, error: result.error,
      });
      if (result.invalidToken) await tx.update(schema.deviceInstallations).set({ isActive: false }).where(eq(schema.deviceInstallations.id, device.id));
    });
  }
  if (accepted) await scheduleReceipts(notification.id, 1);
  return { notificationId: notification.id, devicesCount: devices.length, sent, accepted, failed };
}
