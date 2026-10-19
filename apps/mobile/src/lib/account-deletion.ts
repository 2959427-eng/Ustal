import { ApiRequestError } from "@ustal/api-client";

/**
 * Удаление аккаунта (2026-10-19): тексты ошибок DELETE /me и сам поток (одно действие за раз, сессия
 * очищается только после ответа сервера). Чистая логика — тестируется без экрана.
 */
export function deleteAccountError(err: unknown): { message: string; sessionGone: boolean } {
  if (err instanceof ApiRequestError) {
    if (err.status === 403 && err.code === "invalid_password") return { message: "Неверный пароль", sessionGone: false };
    if (err.status === 409 && err.code === "active_work")
      return { message: "Есть заказы в работе. Завершите их или отметьте результат, затем удалите аккаунт.", sessionGone: false };
    if (err.status === 429) return { message: "Слишком много попыток. Попробуйте позже.", sessionGone: false };
    // Токен больше не действует: аккаунт уже удалён (повтор после потерянного ответа) или сессия истекла.
    if (err.status === 401) return { message: "Сессия завершена. Войдите снова.", sessionGone: true };
  }
  return { message: "Не удалось удалить аккаунт. Проверьте соединение и попробуйте ещё раз.", sessionGone: false };
}

export interface DeleteAccountDeps {
  remove: (password: string) => Promise<void>;
  expire: () => Promise<void>;
}

/** Одно действие за раз: повторное нажатие во время запроса игнорируется. */
export function createAccountDeletion(deps: DeleteAccountDeps) {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(password: string): Promise<{ ok: true } | { ok: false; message: string; sessionGone: boolean } | { ignored: true }> {
      if (busy) return { ignored: true };
      if (!password) return { ok: false, message: "Введите пароль, чтобы подтвердить удаление", sessionGone: false };
      busy = true;
      try {
        await deps.remove(password);
        return { ok: true };
      } catch (err) {
        const e = deleteAccountError(err);
        if (e.sessionGone) await deps.expire().catch(() => undefined);
        return { ok: false, ...e };
      } finally {
        busy = false;
      }
    },
  };
}
