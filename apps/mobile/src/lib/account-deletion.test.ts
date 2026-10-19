import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@ustal/api-client";
import { createAccountDeletion, deleteAccountError } from "./account-deletion";

describe("account deletion UX (2026-10-19)", () => {
  it("maps server answers to clear texts; 401 means the session is gone", () => {
    expect(deleteAccountError(new ApiRequestError("x", 403, "invalid_password"))).toEqual({ message: "Неверный пароль", sessionGone: false });
    expect(deleteAccountError(new ApiRequestError("x", 409, "active_work")).message).toMatch(/заказы в работе/);
    expect(deleteAccountError(new ApiRequestError("x", 429, "too_many_attempts")).message).toMatch(/Слишком много попыток/);
    expect(deleteAccountError(new ApiRequestError("x", 401, "unauthorized")).sessionGone).toBe(true);
    expect(deleteAccountError(new Error("network")).message).toMatch(/Проверьте соединение/);
    // account_blocked (403 без invalid_password) — не «неверный пароль»
    expect(deleteAccountError(new ApiRequestError("x", 403, "account_blocked")).message).not.toBe("Неверный пароль");
  });

  it("one action at a time; empty password is not sent", async () => {
    let release!: () => void;
    const remove = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const flow = createAccountDeletion({ remove, expire: vi.fn(async () => {}) });
    expect(await flow.run("")).toEqual({ ok: false, message: "Введите пароль, чтобы подтвердить удаление", sessionGone: false });
    expect(remove).not.toHaveBeenCalled();
    const first = flow.run("pw");
    expect(await flow.run("pw")).toEqual({ ignored: true });
    release();
    expect(await first).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("wrong password keeps the session; a 401 (already deleted / expired) clears it", async () => {
    const expire = vi.fn(async () => {});
    const bad = createAccountDeletion({ remove: vi.fn(async () => { throw new ApiRequestError("x", 403, "invalid_password"); }), expire });
    expect(await bad.run("pw")).toMatchObject({ ok: false, message: "Неверный пароль", sessionGone: false });
    expect(expire).not.toHaveBeenCalled();
    const gone = createAccountDeletion({ remove: vi.fn(async () => { throw new ApiRequestError("x", 401, "unauthorized"); }), expire });
    expect(await gone.run("pw")).toMatchObject({ ok: false, sessionGone: true });
    expect(expire).toHaveBeenCalledTimes(1);
  });
});
