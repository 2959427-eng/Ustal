import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { assertLocalTestDatabase } from "@ustal/database";

/**
 * Migration 0025 forward safety (аудит Codex №3, 2026-10-17): на отдельных временных БД (*_test) прогоняются
 * миграции до 0024, создаются данные 0024 (ожидающие пересчёта векторов, журнал с равным временем), затем 0025.
 */
assertLocalTestDatabase();
const MIGRATIONS = resolve(__dirname, "../../../packages/database/src/migrations");
const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const created: string[] = [];
afterAll(async () => {
  for (const db of created) await admin.unsafe(`drop database if exists ${db} with (force)`);
  await admin.end();
});

/** Папка миграций до тега включительно (journal обрезан) — так migrator видит БД «как до 0025». */
function folderUpTo(tag: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "ustal-mig-"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"));
  const cut = tag ? journal.entries.findIndex((e: { tag: string }) => e.tag === tag) + 1 : journal.entries.length;
  const entries = journal.entries.slice(0, cut);
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  void readdirSync;
  return dir;
}
async function freshDb() {
  const name = `ustal_mig_${randomUUID().replace(/-/g, "").slice(0, 10)}_test`;
  await admin.unsafe(`create database ${name}`);
  created.push(name);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const run = (tag: string | null) => migrate(drizzle(sql), { migrationsFolder: folderUpTo(tag) });
  return { sql, run };
}
async function user(sql: postgres.Sql) {
  const [u] = await sql`insert into users (phone, password_hash) values (${randomUUID().slice(0, 20)}, 'x') returning id`;
  return u!.id as string;
}
async function profile(sql: postgres.Sql, userId: string, version: number, status: string) {
  const [p] = await sql`insert into capability_profiles (user_id, summary, profile_version, extraction_version, status)
    values (${userId}, 's', ${version}, 'test', ${status}) returning id`;
  return p!.id as string;
}

describe("migration 0025 is forward-safe", () => {
  it("M1/M6. fresh DB through 0025: stale flag, ordered journal; a second run is a no-op", async () => {
    const { sql, run } = await freshDb();
    try {
      await run(null);
      await run(null);
      const cols = await sql`select column_name, is_nullable, is_identity from information_schema.columns
        where (table_name='capability_profiles' and column_name='embedding_stale') or (table_name='profile_item_decisions' and column_name='seq')`;
      expect(cols.map((c) => `${c.column_name}:${c.is_nullable}:${c.is_identity}`).sort()).toEqual(["embedding_stale:NO:NO", "seq:NO:YES"]);
    } finally { await sql.end(); }
  }, 60000);

  it("M2–M5. 0024 with pending refresh rows → 0025: every pending user with an applied profile becomes stale; nothing is lost", async () => {
    const { sql, run } = await freshDb();
    try {
      await run("0024_profile_embedding_refresh");
      const [u1, u2, u3, u4] = [await user(sql), await user(sql), await user(sql), await user(sql)];
      const old1 = await profile(sql, u1, 1, "superseded"), cur1 = await profile(sql, u1, 2, "applied");
      const cur2 = await profile(sql, u2, 1, "applied"), cur3 = await profile(sql, u3, 1, "applied");
      const rebuilding4 = await profile(sql, u4, 1, "rebuild_pending");
      for (const u of [u1, u2, u4]) await sql`insert into profile_embedding_refresh_requests (user_id) values (${u})`;
      await run(null);
      const stale = Object.fromEntries((await sql`select id, embedding_stale from capability_profiles`).map((r) => [r.id, r.embedding_stale]));
      expect([stale[cur1], stale[cur2]]).toEqual([true, true]); // M3/M4
      expect([stale[old1], stale[cur3]]).toEqual([false, false]);
      // M5: no applied profile → the rebuild creates fresh vectors itself; the request row is kept (not lost).
      expect(stale[rebuilding4]).toBe(false);
      expect((await sql`select user_id from profile_embedding_refresh_requests`).map((r) => r.user_id).sort()).toEqual([u1, u2, u4].sort());
    } finally { await sql.end(); }
  }, 60000);

  it("journal backfill: legacy rows with equal decided_at get a deterministic order (decided_at, id), independent of physical order", async () => {
    const orders: string[][] = [];
    for (const physical of [["a", "b", "c"], ["c", "a", "b"]]) {
      const { sql, run } = await freshDb();
      try {
        await run("0024_profile_embedding_refresh");
        const u = await user(sql);
        const ids: Record<string, string> = { a: "00000000-0000-4000-8000-00000000000a", b: "00000000-0000-4000-8000-00000000000b", c: "00000000-0000-4000-8000-00000000000c" };
        for (const k of physical)
          await sql`insert into profile_item_decisions (id, user_id, action, family, identity, snapshot, profile_version, decided_at)
            values (${ids[k]!}, ${u}, ${k}, 'resource', '{}', '{}', 1, '2026-10-17T00:00:00Z')`;
        await run(null);
        orders.push((await sql`select action from profile_item_decisions order by decided_at, seq`).map((r) => r.action as string));
        const [next] = await sql`insert into profile_item_decisions (user_id, action, family, identity, snapshot, profile_version)
          values (${u}, 'new', 'resource', '{}', '{}', 1) returning seq`;
        expect(Number(next!.seq)).toBe(4); // identity continues after the backfill
      } finally { await sql.end(); }
    }
    expect(orders).toEqual([["a", "b", "c"], ["a", "b", "c"]]);
  }, 120000);
});
