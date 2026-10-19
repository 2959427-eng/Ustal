import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "./client.js";

type Db = ReturnType<typeof getDb>;
type Storage = { name: string; cleanupIdentity: string; remove: (key: string) => Promise<void> };

/**
 * Claim briefly under SQL locks, then perform idempotent storage I/O OUTSIDE the transaction.
 * A crash releases the lease after two minutes. Fenced acknowledgements cannot erase a newer claim.
 * Provider mismatches stay pending; never send an old provider's key to the current provider.
 */
export async function drainMediaCleanup(db: Db, storage: Storage, options: { ids?: string[]; limit?: number; now?: Date } = {}) {
  if (options.ids?.length === 0) return { removed: 0, failed: 0 };
  const now = options.now ?? new Date(), lease = randomUUID();
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 10)));
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.mediaCleanupRequests).where(and(
      eq(schema.mediaCleanupRequests.storageProvider, storage.cleanupIdentity),
      lte(schema.mediaCleanupRequests.nextAttemptAt, now),
      options.ids ? inArray(schema.mediaCleanupRequests.id, options.ids) : undefined,
    )).orderBy(asc(schema.mediaCleanupRequests.createdAt), asc(schema.mediaCleanupRequests.id))
      .limit(limit).for("update", { skipLocked: true });
    for (const row of rows) await tx.update(schema.mediaCleanupRequests).set({
      leaseToken: lease, attempts: row.attempts + 1, nextAttemptAt: new Date(now.getTime() + 120_000),
    }).where(eq(schema.mediaCleanupRequests.id, row.id));
    return rows;
  });
  const results = await Promise.all(claimed.map(async (row) => {
    const owned = and(eq(schema.mediaCleanupRequests.id, row.id), eq(schema.mediaCleanupRequests.leaseToken, lease));
    try {
      await storage.remove(row.storageKey);
    } catch {
      // Provider messages may contain signed URLs, credentials or private keys/paths: persist no message.
      const updated = await db.update(schema.mediaCleanupRequests).set({ leaseToken: null, lastErrorCode: "delete_failed",
        nextAttemptAt: new Date(now.getTime() + Math.min(86_400_000, 60_000 * 2 ** Math.min(row.attempts, 11))),
      }).where(owned).returning({ id: schema.mediaCleanupRequests.id });
      return updated.length ? "failed" : "superseded";
    }
    const deleted = await db.delete(schema.mediaCleanupRequests).where(owned).returning({ id: schema.mediaCleanupRequests.id });
    return deleted.length ? "removed" : "superseded";
  }));
  return { removed: results.filter((x) => x === "removed").length, failed: results.filter((x) => x === "failed").length };
}
