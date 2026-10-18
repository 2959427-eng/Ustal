import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@ustal/api-client";
import { apiClient } from "../api/client";
import { getProfile, profileItemAction, type ProfileResponse } from "../api/profile";
import { createItemActions, itemActionError, profileItemRows, type ItemActionState } from "./profile-item-actions";
vi.mock("../api/client", () => ({ apiClient: { request: vi.fn() } }));
const request = vi.mocked(apiClient.request) as unknown as ReturnType<typeof vi.fn>;

/**
 * Phase C (2026-10-17): «Убрать» / «Снять ограничение» / «Восстановить» без AI. Фейковый сервер повторяет
 * контракт Phase A: каждое действие — новая версия и новые id; GET /profile отдаёт removed[].
 */
type Item = { kind: "capability" | "resource" | "restriction"; label: string; type?: "time" | "work" | "scope"; removed: boolean };
function fakeServer(items: Item[]) {
  let version = 1;
  const ids = () => new Map(items.map((it, i) => [`v${version}-${i}`, it]));
  let current = ids();
  const calls: string[] = [];
  const profile = (): ProfileResponse => ({
    profile: { id: `p${version}`, summary: "", profileVersion: version, extractionVersion: "t", createdAt: "" },
    capabilities: [...current].filter(([, it]) => it.kind === "capability" && !it.removed)
      .map(([id, it]) => ({ id, label: it.label, proficiency: "unknown", evidenceType: "explicit", confidence: 0.9 })),
    resources: [...current].filter(([, it]) => it.kind === "resource" && !it.removed)
      .map(([id, it]) => ({ id, label: it.label, resourceType: "other", attributes: {}, evidenceType: "explicit", confidence: 0.9 })),
    unmapped: [],
    restrictions: [...current].filter(([, it]) => it.kind === "restriction" && !it.removed).map(([id, it]) => ({ id, type: it.type!, text: it.label })),
    removed: [...current].filter(([, it]) => it.removed).map(([id, it]) => ({ id, kind: it.kind, label: it.label, decidedAt: "2026-10-17T00:00:00Z" })),
  });
  let failNext: unknown = null;
  request.mockImplementation(async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/profile") return profile();
    const m = path.match(/^\/profile\/items\/(\w+)\/([^/]+)\/(revoke|restore)$/);
    if (!m) throw new Error(`unexpected ${path}`);
    if (failNext) { const e = failNext; failNext = null; throw e; }
    const it = current.get(m[2]!);
    if (!it) throw new ApiRequestError("stale", 409, "stale_item");
    it.removed = m[3] === "revoke";
    version++;
    current = ids();
    return { status: m[3] === "revoke" ? "revoked" : "restored", changed: true, profileVersion: version };
  });
  return { calls, failWith: (e: unknown) => { failNext = e; } };
}
function harness() {
  let cached: ProfileResponse | undefined;
  const states: ItemActionState[] = [];
  const refresh = vi.fn(async () => { cached = await getProfile(); });
  const actions = createItemActions({ call: profileItemAction, refresh, onState: (s) => states.push(s) });
  return { actions, refresh, states, rows: () => profileItemRows(cached), load: refresh };
}
const START: Item[] = [
  { kind: "capability", label: "Сверление бетона", removed: false },
  { kind: "resource", label: "Дрель", removed: false },
  { kind: "restriction", label: "Не работаю после 18:00", type: "time", removed: false },
];
beforeEach(() => { request.mockReset(); });

describe("direct profile item actions (mobile)", () => {
  it("M1. capability «Убрать» → POST revoke → GET /profile: gone from active, listed in «Убранные»", async () => {
    const srv = fakeServer(structuredClone(START));
    const h = harness(); await h.load();
    const row = h.rows().capabilities[0]!;
    expect(await h.actions.run(row, "revoke")).toBe("done");
    expect(srv.calls).toEqual(["GET /profile", `POST /profile/items/capability/${row.id}/revoke`, "GET /profile"]);
    expect(h.rows().capabilities).toEqual([]);
    expect(h.rows().removed.map((r) => [r.kind, r.label])).toEqual([["capability", "Сверление бетона"]]);
  });
  it("M2/M3. resource «Убрать» and «Снять ограничение»; new ids are taken from the refreshed profile", async () => {
    fakeServer(structuredClone(START));
    const h = harness(); await h.load();
    const res = h.rows().resources[0]!;
    await h.actions.run(res, "revoke");
    expect(h.rows().resources).toEqual([]);
    const restriction = h.rows().restrictions[0]!;
    expect(res.id.startsWith("v1-")).toBe(true);
    expect(restriction.id.startsWith("v2-")).toBe(true); // id of the new version, re-read after the action
    expect(restriction.group).toBe("Время");
    await h.actions.run(restriction, "revoke");
    expect(h.rows().restrictions).toEqual([]);
    expect(h.rows().removed.map((r) => r.kind).sort()).toEqual(["resource", "restriction"]);
  });
  it("M4. «Восстановить» → POST restore → refresh: the item is active again", async () => {
    fakeServer(structuredClone(START));
    const h = harness(); await h.load();
    await h.actions.run(h.rows().capabilities[0]!, "revoke");
    expect(await h.actions.run(h.rows().removed[0]!, "restore")).toBe("done");
    expect(h.rows().capabilities.map((c) => c.label)).toEqual(["Сверление бетона"]);
    expect(h.rows().removed).toEqual([]);
  });
  it("M5/M6. pending is set on that item at once; a double tap sends one request", async () => {
    const srv = fakeServer(structuredClone(START));
    const h = harness(); await h.load();
    const row = h.rows().capabilities[0]!;
    const first = h.actions.run(row, "revoke");
    expect(h.states[0]).toEqual({ pendingKey: row.key, error: null, errorKey: null });
    expect(h.actions.busy).toBe(true);
    expect(await h.actions.run(row, "revoke")).toBe("ignored");
    expect(await first).toBe("done");
    expect(srv.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(h.states.at(-1)).toEqual({ pendingKey: null, error: null, errorKey: null });
  });
  it("M7. network/server error: item stays as it was, retry-friendly message, no refresh, can tap again", async () => {
    const srv = fakeServer(structuredClone(START));
    const h = harness(); await h.load();
    const row = h.rows().capabilities[0]!;
    srv.failWith(new TypeError("Network request failed"));
    h.refresh.mockClear();
    expect(await h.actions.run(row, "revoke")).toBe("failed");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.rows().capabilities.map((c) => c.label)).toEqual(["Сверление бетона"]);
    expect(h.states.at(-1)).toMatchObject({ pendingKey: null, errorKey: row.key, error: expect.stringMatching(/соединение/) });
    expect(await h.actions.run(row, "revoke")).toBe("done"); // not stuck
  });
  it("M8. 409 stale_item → profile re-read, the action is NOT repeated automatically", async () => {
    const srv = fakeServer(structuredClone(START));
    const h = harness(); await h.load();
    const row = { ...h.rows().capabilities[0]!, id: "old-version-id", key: "capability:old-version-id" };
    h.refresh.mockClear();
    expect(await h.actions.run(row, "revoke")).toBe("failed");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(srv.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(h.rows().capabilities.map((c) => c.label)).toEqual(["Сверление бетона"]);
    expect(h.states.at(-1)!.error).toMatch(/Нажмите ещё раз/);
  });
  it("M9/M10/404. pending draft, rebuilding, 429 and 404 give clear messages; 404 re-reads the profile", () => {
    expect(itemActionError(new ApiRequestError("x", 409, "profile_draft_pending"))).toEqual({ message: "Сначала примените или отклоните ожидающие изменения профиля.", refresh: false });
    expect(itemActionError(new ApiRequestError("x", 409, "profile_rebuilding"))).toEqual({ message: "Профиль сейчас обновляется. Попробуйте ещё раз через несколько секунд.", refresh: false });
    expect(itemActionError(new ApiRequestError("x", 429, "rate_limited"))).toEqual({ message: "Слишком много изменений профиля. Попробуйте позже.", refresh: false });
    expect(itemActionError(new ApiRequestError("x", 404, "not_found"))).toMatchObject({ refresh: true });
    expect(itemActionError(new ApiRequestError("x", 500))).toMatchObject({ refresh: false, message: expect.stringMatching(/попробуйте ещё раз/) });
  });
  it("M9 (flow). pending draft → the message is shown on that item, the profile is not re-read", async () => {
    const srv = fakeServer(structuredClone(START));
    const h = harness(); await h.load();
    const row = h.rows().resources[0]!;
    srv.failWith(new ApiRequestError("x", 409, "profile_draft_pending"));
    h.refresh.mockClear();
    await h.actions.run(row, "revoke");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toMatchObject({ errorKey: row.key, error: "Сначала примените или отклоните ожидающие изменения профиля." });
  });
  it("M11/M12. works with the AI-message quota exhausted: only /profile/items and GET /profile are called, never the AI message endpoint", async () => {
    const srv = fakeServer(structuredClone(START));
    const h = harness(); await h.load();
    await h.actions.run(h.rows().capabilities[0]!, "revoke");
    await h.actions.run(h.rows().removed[0]!, "restore");
    await h.actions.run(h.rows().restrictions[0]!, "revoke");
    expect(srv.calls.every((c) => c === "GET /profile" || /^POST \/profile\/items\/(capability|resource|restriction)\/[^/]+\/(revoke|restore)$/.test(c))).toBe(true);
    expect(srv.calls.some((c) => c.includes("/profile/inputs") || c.includes("/profile/draft"))).toBe(false);
  });
  it("rows: one row per item, unmapped items need an id, removed[] mapped as is", () => {
    const rows = profileItemRows({
      profile: null, capabilities: [{ id: "c1", label: "Самолёт", proficiency: "unknown", evidenceType: "explicit", confidence: 1 }],
      resources: [], unmapped: [{ id: "f1", kind: "capability", phrase: "самолет." }, { id: "f2", kind: "resource", phrase: "Бетономешалка" }, { kind: "resource", phrase: "Без id" }],
      restrictions: [{ type: "work", text: "Не выполняю перевозки.", id: "r1" }, { type: "time", text: "До 18:00", id: "r2" }],
      removed: [{ id: "m1", kind: "resource", label: "Дрель", decidedAt: null }],
    });
    expect(rows.capabilities.map((r) => r.id)).toEqual(["c1"]);
    expect(rows.resources.map((r) => [r.id, r.label])).toEqual([["f2", "Бетономешалка"]]);
    expect(rows.restrictions.map((r) => [r.id, r.group])).toEqual([["r2", "Время"], ["r1", "Виды работ"]]);
    expect(rows.removed).toEqual([{ key: "resource:m1", kind: "resource", id: "m1", label: "Дрель" }]);
  });
});
