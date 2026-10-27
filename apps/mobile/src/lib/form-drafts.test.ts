import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearFormDraft, clearFormDrafts, formDraftSession, readFormDraft, writeFormDraft } from "./form-drafts";

vi.mock("../api/client", () => ({ apiClient: { request: vi.fn(async () => ({ accessToken: "B-access", refreshToken: "B-refresh" })), cancelAll: vi.fn() }, setCachedAccessToken: vi.fn() }));
vi.mock("../api/session", () => ({ saveTokens: vi.fn(), invalidateTokenWrites: vi.fn(), clearTokens: vi.fn(async () => {}), getRefreshToken: vi.fn(async () => "A-refresh") }));
vi.mock("../notifications/push", () => ({ resetPushRegistrationState: vi.fn(), unregisterPush: vi.fn(async () => {}) }));

const order = { text: "Покрасить забор", priceText: "3000", acceptsPriceOffers: true, photos: [{ mediaId: "m-A", uri: "file:///a.jpg" }] as never[] };
beforeEach(() => clearFormDrafts());

describe("черновики ИИ-форм привязаны к сессии", () => {
  it("хранятся по форме и очищаются по отдельности в своей сессии", () => {
    const s = formDraftSession();
    expect(writeFormDraft("profile", "Умею класть плитку", s)).toBe(true);
    writeFormDraft("order", order, s);
    clearFormDraft("profile", s);
    expect(readFormDraft("profile")).toBeUndefined();
    expect(readFormDraft("order")).toEqual(order);
  });

  it("после смены сессии старое право записи аннулировано: поздняя запись/очистка/чтение со старым номером невозможны", () => {
    const a = formDraftSession();
    writeFormDraft("order", order, a);
    clearFormDrafts(); // logout A
    expect(writeFormDraft("order", order, a)).toBe(false);
    expect(writeFormDraft("profile", "текст A", a)).toBe(false);
    clearFormDrafts(); // login B
    const b = formDraftSession();
    expect(readFormDraft("order", b)).toBeUndefined();
    expect(readFormDraft("profile", b)).toBeUndefined();
    writeFormDraft("profile", "текст B", b);
    expect(clearFormDraft("profile", a)).toBe(false); // поздний обработчик A не стирает черновик B
    expect(readFormDraft("profile", a)).toBeUndefined(); // и не читает его
    expect(readFormDraft("profile", b)).toBe("текст B");
  });

  it("выход, вход, регистрация и удаление аккаунта аннулируют черновики и права записи", async () => {
    const { login, logout, deleteAccount, register } = await import("../api/auth");
    for (const change of [() => logout(), () => login("+70000000000", "pw"), () => deleteAccount("pw"),
      () => register({ name: "B", phone: "+70000000001", password: "pw", cityId: "c", acceptedAge18: true, acceptedRules: true, acceptedPdn: true })]) {
      const old = formDraftSession();
      writeFormDraft("profile", "текст пользователя A", old);
      writeFormDraft("order", order, old);
      await change();
      expect(formDraftSession()).not.toBe(old);
      expect(writeFormDraft("order", order, old)).toBe(false);
      expect(readFormDraft("profile")).toBeUndefined();
      expect(readFormDraft("order")).toBeUndefined();
    }
  });

  it("повторный вход в тот же аккаунт создаёт новую сессию: новый id, старое право записи аннулировано", async () => {
    const { login, logout } = await import("../api/auth");
    await login("+70000000001", "pw");
    const first = formDraftSession();
    writeFormDraft("profile", "текст", first);
    await logout();
    await login("+70000000001", "pw");
    expect(formDraftSession().id).not.toBe(first.id);
    expect(writeFormDraft("profile", "поздний текст", first)).toBe(false);
    expect(readFormDraft("profile")).toBeUndefined();
  });
});
