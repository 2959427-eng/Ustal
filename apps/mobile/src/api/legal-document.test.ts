import { describe, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiBaseUrl: "https://api.ustal.test" } } } }));
const page = '<main><h1>USTAL — Политика конфиденциальности</h1><h2>Данные</h2><p>Текст.</p><footer><p>Версия 2026-10-26. Действует с 2026-10-26.</p></footer></main>';
const ok = (body: string) => ({ ok: true, status: 200, text: async () => body }) as Response;

describe("загрузка документа с сервера", () => {
  it("rejects redirected pages and forwards cancellation without sending credentials", async () => {
    const { loadLegalDocument } = await import("./legal-document");
    await expect(loadLegalDocument("privacy", { fetchImpl: vi.fn(async () => ({ ...ok(page), redirected: true })) })).rejects.toThrow("legal_document_redirect");
    const owner = new AbortController();
    const fetchImpl = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = loadLegalDocument("privacy", { fetchImpl, signal: owner.signal });
    owner.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error", credentials: "omit" });
  });
  it("публичная страница сервера без токена и cookies, без кеша", async () => {
    const { loadLegalDocument } = await import("./legal-document");
    const fetchImpl = vi.fn(async () => ok(page));
    const view = await loadLegalDocument("privacy", { fetchImpl });
    expect(view.title).toBe("USTAL — Политика конфиденциальности");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.ustal.test/privacy");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store" });
    expect(JSON.stringify(init.headers)).not.toMatch(/Authorization/i);
  });
  it("ошибка сервера, нечитаемая страница и небезопасный адрес — ошибка, без подмены текста", async () => {
    const { loadLegalDocument } = await import("./legal-document");
    await expect(loadLegalDocument("terms", { fetchImpl: vi.fn(async () => ({ ok: false, status: 503, text: async () => "" }) as Response) })).rejects.toThrow("legal_document_503");
    await expect(loadLegalDocument("terms", { fetchImpl: vi.fn(async () => ok("<html>oops</html>")) })).rejects.toThrow("legal_document_unreadable");
    const fetchImpl = vi.fn(async () => ok(page));
    await expect(loadLegalDocument("terms", { origin: "http://insecure.test", fetchImpl })).rejects.toThrow();
    await expect(loadLegalDocument("terms", { origin: null, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("все ссылки на документы в приложении открывают встроенное окно", () => {
  it("в LegalLinks нет Linking.openURL, экраны используют только LegalLink/LegalLinks", async () => {
    const { readFileSync } = await import("node:fs");
    const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
    expect(src("src/components/LegalLinks.tsx")).not.toMatch(/Linking|openURL/);
    // Аккаунт: документы показываются только при регистрации/входе (решение владельца 2026-10-29); поддержка — форма.
    expect(src("app/(tabs)/account.tsx")).not.toMatch(/LegalLinks|LegalDocument|legalUrl\(|Linking|openURL/);
    expect(src("app/(tabs)/account.tsx")).toMatch(/router\.push\("\/support"\)/);
    for (const screen of ["app/(auth)/register.tsx", "app/support.tsx", "app/(auth)/login.tsx", "app/(auth)/select-city.tsx", "app/ai-consent.tsx"]) {
      // Встроенные ссылки в тексте отметок (регистрация) открывают то же окно LegalDocumentModal напрямую.
      expect(src(screen)).toMatch(/<LegalLinks? |<LegalDocumentModal /);
      expect(src(screen)).not.toMatch(/legalUrl\(|Linking|openURL/);
    }
  });
});
