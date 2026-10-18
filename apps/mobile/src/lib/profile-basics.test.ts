import { describe, expect, it } from "vitest";
import { buildProfileBasicsPatch } from "./profile-basics";

const current = { name: "Анна", cityId: "city-1", avatarMediaId: "media-1" };

describe("buildProfileBasicsPatch (окно «Основные данные»)", () => {
  it("nothing changed -> no request", () => {
    expect(buildProfileBasicsPatch(current, { name: " Анна ", cityId: "city-1" })).toEqual({ ok: true, patch: null });
  });
  it("all three fields in one patch, only changed ones", () => {
    expect(buildProfileBasicsPatch(current, { name: "Анна П.", cityId: "city-2", avatarMediaId: "media-2" }))
      .toEqual({ ok: true, patch: { name: "Анна П.", cityId: "city-2", avatarMediaId: "media-2" } });
    expect(buildProfileBasicsPatch(current, { name: "Анна", cityId: "city-2" })).toEqual({ ok: true, patch: { cityId: "city-2" } });
    expect(buildProfileBasicsPatch(current, { name: "Анна", cityId: "city-1", avatarMediaId: "media-2" })).toEqual({ ok: true, patch: { avatarMediaId: "media-2" } });
  });
  it("name is trimmed and required; city is required", () => {
    expect(buildProfileBasicsPatch(current, { name: "  Борис  ", cityId: "city-1" })).toEqual({ ok: true, patch: { name: "Борис" } });
    expect(buildProfileBasicsPatch(current, { name: "   ", cityId: "city-1" })).toEqual({ ok: false, error: "Введите имя." });
    expect(buildProfileBasicsPatch(current, { name: "x".repeat(101), cityId: "city-1" }).ok).toBe(false);
    expect(buildProfileBasicsPatch({ ...current, cityId: null }, { name: "Анна", cityId: null })).toEqual({ ok: false, error: "Выберите город." });
  });
  it("the same avatar is not re-sent", () => {
    expect(buildProfileBasicsPatch(current, { name: "Анна", cityId: "city-1", avatarMediaId: "media-1" })).toEqual({ ok: true, patch: null });
  });
});
