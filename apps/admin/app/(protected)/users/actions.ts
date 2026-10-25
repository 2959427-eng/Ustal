"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@ustal/database";
import { requireAdminPermission } from "../../../lib/session";
import { assertOneOf, USER_STATUS_VALUES } from "../../../lib/admin-access";

/**
 * Блокировка аккаунта — сразу разрывает возможность получать новые access
 * token'ы (см. фикс POST /auth/refresh, docs/architecture.md §5): уже
 * выданный access token недолго проживёт сам (ACCESS_TOKEN_TTL_MINUTES), а
 * следующий refresh получит 401 и отзовёт сессию.
 */
export async function setUserStatusAction(userId: string, status: "active" | "blocked") {
  await requireAdminPermission("users.set_status");
  status = assertOneOf(status, USER_STATUS_VALUES);
  const db = getDb();
  // Только active <-> blocked: удалённый аккаунт (status=deleted) не «оживить» вызовом action напрямую.
  await db.update(schema.users).set({ status }).where(and(eq(schema.users.id, userId), inArray(schema.users.status, ["active", "blocked"])));
  if (status === "blocked") {
    // Разрываем уже выданные refresh-сессии; access-токен перестаёт работать сам (проверка status в API).
    await db
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.userSessions.userId, userId), isNull(schema.userSessions.revokedAt)));
  }
  revalidatePath("/users");
}
