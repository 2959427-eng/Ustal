import type PgBoss from "pg-boss";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getPushProvider } from "@ustal/notifications";

export interface NotificationDispatchJobData {
  notificationId: string;
}

/**
 * Push-доставка уведомления (docs/api.md «Уведомления и устройства»,
 * docs/data-model.md `push_deliveries`). In-app уведомление (`notifications`
 * row) уже создано синхронно самим api (apps/api/src/lib/notify.ts) —
 * этот worker только пытается протолкнуть push на активные устройства
 * пользователя, по одной попытке на устройство, независимо друг от друга
 * (сбой на одном устройстве не должен блокировать доставку на другое).
 *
 * `title`/`body` берутся из `notifications.payload` (записаны вызывающей
 * стороной при создании уведомления) — worker не хранит собственный каталог
 * шаблонов текста, чтобы не дублировать логику формулировок между api и
 * worker (см. docs/architecture.md §1).
 */
export async function handleNotificationDispatch(job: PgBoss.Job<NotificationDispatchJobData>) {
  const db = getDb();

  const notification = await db.query.notifications.findFirst({
    where: eq(schema.notifications.id, job.data.notificationId),
  });
  if (!notification) throw new Error(`notification ${job.data.notificationId} not found`);

  const devices = await db.query.deviceInstallations.findMany({
    where: and(
      eq(schema.deviceInstallations.userId, notification.userId),
      eq(schema.deviceInstallations.isActive, true),
    ),
  });

  if (devices.length === 0) {
    return { notificationId: notification.id, devicesCount: 0, sent: 0, failed: 0 };
  }

  const payload = notification.payload as { title?: string; body?: string } | null;
  const title = payload?.title ?? "USTAL";
  const body = payload?.body ?? "У вас новое уведомление";

  const provider = getPushProvider();
  let sent = 0;
  let failed = 0;

  for (const device of devices) {
    const result = await provider.send({
      expoPushToken: device.expoPushToken,
      title,
      body,
      data: { notificationId: notification.id, type: notification.type },
    });
    if (result.ok) sent += 1;
    else failed += 1;

    await db.insert(schema.pushDeliveries).values({
      notificationId: notification.id,
      deviceInstallationId: device.id,
      status: result.ok ? "sent" : "failed",
      providerMessageId: result.providerMessageId,
      sentAt: result.ok ? new Date() : null,
      error: result.error,
    });
  }

  return { notificationId: notification.id, devicesCount: devices.length, sent, failed };
}
