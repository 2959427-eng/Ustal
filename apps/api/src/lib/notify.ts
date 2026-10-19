import { getDb, schema } from "@ustal/database";
import { getBoss, JOB_TYPES } from "@ustal/queue";

/**
 * Единая точка создания уведомления (docs/data-model.md `notifications`) +
 * постановка задачи на push-доставку (`notification_dispatch`, worker-
 * обработчик apps/worker/src/handlers/notification-dispatch.ts). in-app
 * уведомление (`GET /notifications`) не зависит от того, дойдёт ли push:
 * запись в БД создаётся синхронно и сразу видна в списке, push — best-effort
 * вдогонку через очередь (тот же принцип, что и AI-обработка: api никогда не
 * ждёт синхронно внешний сетевой вызов).
 */
export async function notifyUser(
  userId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const db = getDb();
  const [notification] = await db
    .insert(schema.notifications)
    .values({ userId, type, payload })
    .returning({ id: schema.notifications.id });
  // The DB guard skips a late delivery to an account deleted during the sender's action.
  if (!notification) return null;

  const boss = await getBoss();
  await boss.send(JOB_TYPES.NOTIFICATION_DISPATCH, { notificationId: notification.id });

  return notification.id;
}
