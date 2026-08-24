import { getDb, schema } from "@ustal/database";
import { getBoss, JOB_TYPES } from "@ustal/queue";

/**
 * То же самое, что apps/api/src/lib/notify.ts — не вынесено в общий пакет,
 * чтобы не тянуть Fastify-специфичные типы в Next.js сборку; сама логика
 * (создать notifications row + поставить notification_dispatch job)
 * тривиальна и продублирована один раз здесь для админки.
 */
export async function notifyUser(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const [notification] = await db.insert(schema.notifications).values({ userId, type, payload }).returning({ id: schema.notifications.id });
  if (!notification) throw new Error("Failed to create notification");
  const boss = await getBoss();
  await boss.send(JOB_TYPES.NOTIFICATION_DISPATCH, { notificationId: notification.id });
}
