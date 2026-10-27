import { afterEach, describe, expect, it, vi } from "vitest";
import { secureRandomId } from "./secure-id";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock("expo-crypto"); });

describe("идентификатор сессии: криптостойкий, не повторяется между запусками", () => {
  it("два независимых JS-контекста получают разные 128-битные id", async () => {
    vi.resetModules();
    const a = (await import("./form-drafts")).formDraftSession().id;
    vi.resetModules();
    const b = (await import("./form-drafts")).formDraftSession().id;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(["0", "1", "2"]).not.toContain(a); // не счётчик
  });

  it("id чужого запуска (в том числе бывший счётчик «1») не принимается; свой — принимается", async () => {
    vi.resetModules();
    const previousLaunch = (await import("./form-drafts")).formDraftSession().id!;
    vi.resetModules();
    const drafts = await import("./form-drafts");
    for (const id of [previousLaunch, "1", "0", "", undefined]) expect(drafts.isCurrentDraftSession(id)).toBe(false);
    expect(drafts.isCurrentDraftSession(drafts.formDraftSession().id!)).toBe(true);
    const before = drafts.formDraftSession().id!;
    drafts.clearFormDrafts();
    expect(drafts.isCurrentDraftSession(before)).toBe(false);
  });

  it("без стойкого источника (нет Web Crypto и expo-crypto) id нет — параметры навигации не принимаются", async () => {
    expect(secureRandomId(null)).toBeNull();
    expect(secureRandomId(() => {})).toBeNull(); // источник не заполнил буфер
    expect(secureRandomId(() => { throw new Error("no native module"); })).toBeNull();
    vi.stubGlobal("crypto", undefined);
    vi.doMock("expo-crypto", () => { throw new Error("Cannot find native module 'ExpoCrypto'"); });
    vi.resetModules();
    const drafts = await import("./form-drafts");
    expect(drafts.formDraftSession().id).toBeNull();
    expect(drafts.isCurrentDraftSession("null")).toBe(false);
  });
});
