import Constants from "expo-constants";
import { legalUrl, type LegalPage } from "../lib/legal-links";
import { parseLegalHtml, type LegalDocumentView } from "../lib/legal-document";

/**
 * Действующий документ с сервера (та же страница, что открывалась в браузере): точный текст, версия, дата.
 * Публичная страница — без токена и cookies; ответ не кешируется приложением.
 */
export async function loadLegalDocument(
  page: LegalPage,
  { origin = Constants.expoConfig?.extra?.apiBaseUrl as unknown, fetchImpl = fetch, timeoutMs = 15_000, signal }: { origin?: unknown; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LegalDocumentView> {
  if (typeof origin !== "string") throw new Error("missing_legal_origin");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(legalUrl(origin, page), { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", headers: { Accept: "text/html" }, signal: controller.signal });
    if (res.redirected) throw new Error("legal_document_redirect");
    if (!res.ok) throw new Error(`legal_document_${res.status}`);
    const view = parseLegalHtml(await res.text());
    if (!view) throw new Error("legal_document_unreadable");
    return view;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
