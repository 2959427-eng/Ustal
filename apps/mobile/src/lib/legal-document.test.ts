import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLegalHtml } from "./legal-document";
import { legalLinks } from "./legal-links";
// Контракт с сервером: тот же рендер, что отдаёт GET /{page} (apps/api/src/routes/legal.ts), и утверждённые документы.
import { renderLegalPage, titles } from "../../../api/src/legal/pages";
import { validatePublication } from "../../../api/src/legal/publication";

const doc = (name: string) => readFileSync(new URL(`../../../../docs/launch/legal/${name}.md`, import.meta.url), "utf8");
const pages = ["privacy", "terms", "community-guidelines", "delete-account", "support"] as const;
const publication = validatePublication({
  approved: true, version: "2026-10-26", effectiveDate: "2026-10-26", supportEmail: "support@ustal.site", publicOrigin: "https://ustal.site",
  documents: Object.fromEntries(pages.map((p) => [p, doc(p)])),
});
/** Текст абзацев/пунктов исходного документа после серверного рендера (без разметки Markdown). */
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1");
/** Ссылки mailto сервер на странице поддержки превращает в <a>: сравниваем видимый текст. */
const visible = (s: string) => s.replace(/\[([^\]]+)\]\(mailto:[^)]+\)/g, "$1");

describe("юридические документы в приложении — точный текст действующей серверной страницы", () => {
  it("active HTML and arbitrary anchor targets remain inert plain text", () => {
    const view = parseLegalHtml('<main><h1>Title</h1><script>alert(1)</script><style>evil</style><p onclick="evil()"><a href="javascript:evil()">Read</a> <a href="https://evil.test">more</a><img src=x onerror=evil()></p></main>')!;
    expect(view).toEqual({ title: "Title", blocks: [{ kind: "p", text: "Read more" }] });
  });
  it("все ссылки приложения покрыты серверными страницами", () => {
    for (const [page] of legalLinks) expect(Object.keys(titles)).toContain(page);
  });

  for (const page of pages) {
    it(`${page}: заголовок, каждый абзац и пункт документа, версия и дата — без искажений`, () => {
      const view = parseLegalHtml(renderLegalPage(page, publication))!;
      expect(view.title).toBe(`USTAL — ${titles[page]}`);
      const shown = view.blocks.map((b) => b.text);
      const source = doc(page).replace(/\r\n/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
      for (const block of source) {
        if (/^#\s/.test(block)) continue; // заголовок документа — в шапке окна
        const lines = block.split("\n");
        const all = visible(shown.join("\n"));
        if (lines.every((l) => /^-\s+/.test(l))) for (const l of lines) expect(all).toContain(visible(plain(l.replace(/^-\s+/, ""))));
        else if (/^#{2,3}\s/.test(block)) expect(all).toContain(block.replace(/^#{2,3}\s+/, ""));
        else if (!/^Оператор: Ким Дмитрий Эдуардович, Россия\./.test(block)) expect(all).toContain(visible(plain(lines.join("\n"))));
      }
      expect(view.blocks.filter((b) => b.kind === "meta").map((b) => b.text)).toContain("Версия 2026-10-26. Действует с 2026-10-26.");
    });
  }

  it("форма входа веб-страницы удаления, скрипты и навигация в окно не попадают; HTML-сущности раскодируются как текст", () => {
    const html = '<!doctype html><html><body><nav><a href="/x">Меню</a></nav><main><h1>USTAL — Документ</h1><p>Текст &lt;script&gt;x&lt;/script&gt; &amp; «кавычки» &quot;q&quot;<br>вторая строка</p>'
      + '<form id="login-form"><h2>1. Войдите в свой аккаунт</h2><label>Телефон <input></label></form><section id="account" hidden><h2>2. Подтвердите</h2></section>'
      + '<ul><li><strong>Пункт</strong> один</li></ul><footer><p>Версия 1.</p></footer></main><script>alert(1)</script></body></html>';
    expect(parseLegalHtml(html)).toEqual({ title: "USTAL — Документ", blocks: [
      { kind: "p", text: "Текст <script>x</script> & «кавычки» \"q\"\nвторая строка" },
      { kind: "li", text: "Пункт один" },
      { kind: "meta", text: "Версия 1." },
    ] });
  });

  it("пустая или чужая страница не показывается как документ", () => {
    expect(parseLegalHtml("<html><body>Bad gateway</body></html>")).toBeNull();
    expect(parseLegalHtml("<main><h1>USTAL</h1><footer><p>Версия</p></footer></main>")).toBeNull();
  });
});
