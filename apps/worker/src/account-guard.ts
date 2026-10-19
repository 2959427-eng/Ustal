import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";

/**
 * Удалённый аккаунт (DELETE /me, 2026-10-19): задачи профиля, поставленные или начатые до удаления, завершаются
 * без AI и без повторов. Запись для удалённого пользователя всё равно невозможна (миграция 0026, SQLSTATE UX001) —
 * здесь только превращаем это в тихий пропуск вместо цепочки повторов pg-boss.
 */
export async function isAccountDeleted(userId: string | undefined | null): Promise<boolean> {
  if (!userId) return false;
  const user = await getDb().query.users.findFirst({ where: eq(schema.users.id, userId), columns: { status: true } });
  return user?.status === "deleted";
}

export function isDeletedAccountWrite(error: unknown): boolean {
  const e = error as { cause?: { code?: string }; code?: string };
  return (e.cause?.code ?? e.code) === "UX001";
}

export function skipDeletedAccount<J extends { data: { userId?: string } }, R>(handler: (job: J) => Promise<R>) {
  return async (job: J): Promise<R | { skipped: "account_deleted" }> => {
    if (await isAccountDeleted(job.data.userId)) return { skipped: "account_deleted" };
    try {
      return await handler(job);
    } catch (error) {
      if (isDeletedAccountWrite(error) || (await isAccountDeleted(job.data.userId))) return { skipped: "account_deleted" };
      throw error;
    }
  };
}
