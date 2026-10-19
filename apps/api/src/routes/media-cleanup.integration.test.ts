import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import authenticate from "../plugins/authenticate.js";
import { signAccessToken } from "../lib/auth-tokens.js";
import { mapPgError } from "../lib/pg-errors.js";

const storage = vi.hoisted(() => ({ name: "s3", cleanupIdentity: "s3:test-bucket", upload: vi.fn(), remove: vi.fn(), resolvePath: vi.fn() }));
vi.mock("@ustal/storage", () => ({ getMediaStorage: () => storage }));
import mediaRoutes from "./media.js";

assertLocalTestDatabase();
const db = getDb(), userIds: string[] = [], keys: string[] = [];
afterAll(async () => {
  for (const id of userIds) await db.delete(schema.users).where(eq(schema.users.id, id));
  for (const key of keys) await db.delete(schema.mediaCleanupRequests).where(eq(schema.mediaCleanupRequests.storageKey, key));
  await getSql().end();
});

describe("upload overlapping account deletion", () => {
  it("retains cleanup when upload succeeds, the deleted-user guard rejects persistence and DeleteObject fails", async () => {
    const [user] = await db.insert(schema.users).values({ phone: `+7${Math.floor(1e9 + Math.random() * 9e9)}`, passwordHash: "unused" }).returning();
    userIds.push(user!.id);
    const key = `photo/${user!.id}/${randomUUID()}.jpg`; keys.push(key);
    storage.upload.mockImplementation(async () => {
      // Authentication has succeeded; deletion commits while storage I/O is still in flight.
      await db.update(schema.users).set({ status: "deleted" }).where(eq(schema.users.id, user!.id));
      return { storageKey: key };
    });
    storage.remove.mockRejectedValue(Error("AccessDenied; signed private response"));
    const app = Fastify();
    app.setErrorHandler((error, _req, reply) => {
      const mapped = mapPgError(error);
      return reply.code(mapped?.status ?? 500).send(mapped?.body ?? { error: { code: "internal_error" } });
    });
    await app.register(authenticate); await app.register(multipart); await app.register(mediaRoutes);
    const boundary = "audit-boundary";
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nphoto\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\nphoto-data\r\n--${boundary}--\r\n`);
    try {
      const res = await app.inject({ method: "POST", url: "/media", headers: { authorization: `Bearer ${signAccessToken(user!.id)}`, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
      expect(res.statusCode, res.body).toBe(401);
      expect(storage.upload).toHaveBeenCalledTimes(1); expect(storage.remove).toHaveBeenCalledTimes(1);
      expect(await db.select().from(schema.media).where(eq(schema.media.ownerId, user!.id))).toEqual([]);
      const pending = await db.select().from(schema.mediaCleanupRequests).where(eq(schema.mediaCleanupRequests.storageKey, key));
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ storageProvider: storage.cleanupIdentity, attempts: 1, lastErrorCode: "delete_failed" });
    } finally { await app.close(); }
  });
});
