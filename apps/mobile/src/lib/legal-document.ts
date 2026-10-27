/**
 * Разбор действующей юридической страницы сервера (GET /{page}, HTML из renderLegalPage) для показа в приложении.
 * Текст берётся с сервера как есть — без собственных копий документов; разметка ограничена тем, что выдаёт сервер
 * (h1–h3, p, ul/li, br, strong, a, footer). Формы, скрипты и навигация страницы в приложении не показываются.
 */
export type LegalBlock = { kind: "h2" | "h3" | "p" | "li" | "meta"; text: string };
export interface LegalDocumentView { title: string; blocks: LegalBlock[] }

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") {
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  }
  return NAMED[e.toLowerCase()] ?? m;
});
const text = (inner: string) => decode(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")).replace(/[ \t]+\n/g, "\n").trim();

export function parseLegalHtml(html: string): LegalDocumentView | null {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)?.[1];
  if (!main) return null;
  const content = main
    .replace(/<(form|script|style|nav|button|label)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<section\b[^>]*\bhidden\b[\s\S]*?<\/section>/gi, "");
  const footerAt = content.search(/<footer\b/i);
  let title = "";
  const blocks: LegalBlock[] = [];
  for (const m of content.matchAll(/<(h1|h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1]!.toLowerCase(), value = text(m[2]!);
    if (!value) continue;
    if (tag === "h1") { if (!title) title = value; continue; }
    blocks.push({ kind: footerAt >= 0 && m.index! > footerAt ? "meta" : (tag as LegalBlock["kind"]), text: value });
  }
  return title && blocks.some((b) => b.kind !== "meta") ? { title, blocks } : null;
}
