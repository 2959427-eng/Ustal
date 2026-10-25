export const deletionHtml = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>USTAL — удаление аккаунта</title></head><body>
<main><h1>USTAL — удаление аккаунта</h1><p>Локальный функциональный предпросмотр. Публичная публикация ещё не утверждена.</p>
<p>Удаляются активные данные профиля, сессии и устройства. Завершённые заказы, отзывы, оценки, отчёты и служебные записи могут сохраняться с обезличенным профилем. Очистка файлов выполняется с повторными попытками. Мгновенное удаление резервных копий не обещается; сроки хранения ещё утверждаются.</p>
<form id="login-form"><h2>1. Войдите в свой аккаунт</h2><label>Телефон <input id="phone" type="tel" autocomplete="off" required maxlength="30"></label><label>Пароль <input id="login-password" type="password" autocomplete="off" required maxlength="200"></label><button id="login" type="submit">Войти</button></form>
<section id="account" hidden><h2>2. Подтвердите аккаунт</h2><p id="identity"></p><p>Проверьте имя, телефон и идентификатор. Это действие необратимо. При незавершённой работе сначала урегулируйте результат в приложении.</p>
<form id="delete-form"><label>Введите пароль повторно <input id="delete-password" type="password" autocomplete="off" required maxlength="200"></label><label><input id="confirm" type="checkbox" required> Я подтверждаю удаление именно этого аккаунта</label><button id="delete" type="submit">Удалить мой аккаунт</button></form><button id="logout" type="button">Выйти / другой аккаунт</button></section>
<p id="status" role="status" aria-live="polite"></p></main><script src="/account/delete/client.js" defer></script></body></html>`;

export const deletionClient = String.raw`(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const ids = ["login", "delete", "logout", "phone", "login-password", "delete-password", "confirm"];
  let access = "", refresh = "", userId = "", busy = false, generation = 0;
  const status = (text) => { byId("status").textContent = text; };
  const pending = (value) => { busy = value; ids.forEach((id) => { byId(id).disabled = value; }); byId("status").setAttribute("aria-busy", String(value)); };
  const clearPasswords = () => { byId("login-password").value = ""; byId("delete-password").value = ""; byId("confirm").checked = false; };
  const clear = () => { access = ""; refresh = ""; userId = ""; generation++; clearPasswords(); byId("phone").value = ""; byId("identity").textContent = ""; byId("account").hidden = true; byId("login-form").hidden = false; };
  const request = async (path, method, body, token) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, { method, credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = response.ok && (path === "/auth/login" || method === "GET") ? await response.json() : null;
      return { status: response.status, ok: response.ok, json: async () => data };
    } finally { clearTimeout(timer); }
  };
  const endSession = async (token, refreshToken) => {
    if (token && refreshToken) try { await request("/auth/logout", "POST", { refreshToken }, token); } catch {}
  };
  const failure = (code, deleting) => {
    if (code === 401) { clear(); return "Сессия недействительна. Войдите снова. Это не подтверждение удаления."; }
    if (code === 403) return "Пароль неверен. Удаление не подтверждено; введите пароль повторно.";
    if (code === 409) return "Удаление заблокировано незавершённой работой. Урегулируйте её в приложении.";
    if (code === 429) return "Слишком много попыток. Подождите перед повторной попыткой.";
    return deleting ? "Сервер не подтвердил удаление. Не считайте аккаунт удалённым." : "Не удалось войти и подтвердить аккаунт.";
  };
  byId("login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (busy) return; pending(true); status("Вход…");
    const epoch = generation; let sessionAccess = "", sessionRefresh = "";
    try {
      const response = await request("/auth/login", "POST", { phone: byId("phone").value.trim(), password: byId("login-password").value });
      byId("login-password").value = "";
      if (!response.ok) { status(failure(response.status, false)); return; }
      const login = await response.json(); sessionAccess = login.accessToken; sessionRefresh = login.refreshToken;
      if (typeof sessionAccess !== "string" || !sessionAccess || typeof sessionRefresh !== "string" || !sessionRefresh || typeof login.userId !== "string") throw Error("invalid_session");
      const meResponse = await request("/me", "GET", null, sessionAccess);
      if (!meResponse.ok) { status(failure(meResponse.status, false)); return; }
      const me = await meResponse.json();
      if (me.id !== login.userId || typeof me.phone !== "string" || typeof me.name !== "string") throw Error("invalid_identity");
      if (epoch !== generation) return;
      access = sessionAccess; refresh = sessionRefresh; userId = me.id;
      byId("identity").textContent = me.name + " — " + me.phone + " — ID: " + me.id;
      byId("account").hidden = false; byId("login-form").hidden = true;
      status("Проверьте аккаунт и повторно введите пароль. Удаление ещё не запрошено.");
    } catch { status("Сеть или ответ недоступны. Вход не подтверждён."); }
    finally { clearPasswords(); if (sessionAccess && sessionAccess !== access) await endSession(sessionAccess, sessionRefresh); pending(false); }
  });
  byId("delete-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (busy || !access || !userId || !byId("confirm").checked || !byId("delete-password").value) return;
    pending(true); status("Удаление…");
    try {
      const response = await request("/me", "DELETE", { password: byId("delete-password").value }, access);
      if (response.status === 204) { clear(); status("Сервер подтвердил удаление аккаунта. Сроки сохранения отдельных записей описаны выше."); }
      else status(failure(response.status, true));
    } catch {
      const oldAccess = access, oldRefresh = refresh; clear();
      status("Ответ не получен: результат удаления неизвестен. Не повторяем запрос автоматически. Войдите снова, чтобы проверить доступ; ошибка входа сама по себе не доказывает удаление.");
      await endSession(oldAccess, oldRefresh);
    } finally { clearPasswords(); pending(false); }
  });
  byId("logout").addEventListener("click", async () => {
    if (busy) return; pending(true); const oldAccess = access, oldRefresh = refresh; clear();
    status("Данные входа очищены на этой странице."); await endSession(oldAccess, oldRefresh); pending(false);
  });
  window.addEventListener("pagehide", clear);
  window.addEventListener("pageshow", (event) => { if (event.persisted) { clear(); pending(false); status("Войдите снова после возврата на страницу."); } });
})();`;
