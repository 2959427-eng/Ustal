import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import routes from "./legal.js";
import { validatePublication } from "../legal/publication.js";
import { renderLegalMarkdown } from "../legal/markdown.js";
import { renderLegalPage, titles } from "../legal/pages.js";

const approved = () => validatePublication({ approved: true, version: "test-only", effectiveDate: "2026-10-21", supportEmail: "support@ustal.test", publicOrigin: "https://ustal.test", agePolicy: "Test fixture age policy", territories: "Test fixture territories", retention: "Test fixture retention", backupRetention: "Test fixture backups", processors: "Test fixture processors", processingLocations: "Test fixture locations", legalBasis: "Test fixture legal basis", activeWorkSupport: "Test fixture manual resolution" });
afterEach(() => vi.unstubAllEnvs());
describe("legal publication boundary", () => {
  it("publishes the exact approved owner documents instead of legacy section text", async () => {
    const documents = Object.fromEntries(Object.keys(titles).map(page => [page, `## OWNER ${page}\n\nExact owner text <script>unsafe</script>.` ]));
    const bundle = { approved: true, version: "2026-10-26", effectiveDate: "2026-10-26", supportEmail: "support@ustal.test", publicOrigin: "https://ustal.test", documents };
    expect(() => validatePublication({ ...bundle, documents: { ...documents, privacy: "При необходимости обратитесь в поддержку." } })).not.toThrow();
    for (const marker of ["[PLACEHOLDER]", "[УКАЗАТЬ]", "[ПРОВЕРИТЬ]", "TBD", "TODO", "placeholder", "НЕОБХОДИМО УТВЕРДИТЬ срок", "НЕОБХОДИМО ПОДТВЕРДИТЬ страну", "НА УТВЕРЖДЕНИЕ", "ПРОЕКТ"]) {
      expect(() => validatePublication({ ...bundle, documents: { ...documents, privacy: marker } })).toThrow();
    }
    const publication = validatePublication(bundle);
    const app = Fastify(); await app.register(routes, { publication });
    try {
      for (const page of Object.keys(titles)) {
        const response = await app.inject(`/${page}`);
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain("<nav");
        for (const destination of Object.keys(titles)) expect(response.body).not.toContain(`href="/${destination}"`);
        expect(response.body).toContain(`OWNER ${page}`);
        expect(response.body).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
        expect(response.body).not.toContain("<script>unsafe");
      }
      expect((await app.inject("/delete-account")).body).toContain('id="login-form"');
      expect((await app.inject("/delete-account")).body).toContain('/account/delete/client.js');
    } finally { await app.close(); }
    expect(() => validatePublication({ ...bundle, approved: false })).toThrow();
    expect(() => validatePublication({ ...bundle, documents: { ...documents, privacy: "[DATA_RETENTION_TBD]" } })).toThrow();
    expect(() => validatePublication({ ...bundle, documents: { ...documents, support: "" } })).toThrow();
    const incomplete = { ...documents }; delete incomplete.terms;
    expect(() => validatePublication({ ...bundle, documents: incomplete })).toThrow();
  });
  it("shows one deletion heading without operator details and preserves the remaining owner text and form", async () => {
    const original = readFileSync(new URL("../../../../docs/launch/legal/delete-account.md", import.meta.url), "utf8");
    const documents = Object.fromEntries(Object.keys(titles).map(page => [page, page === "delete-account" ? original : `## OWNER ${page}`]));
    const publication = validatePublication({ approved: true, version: "2026-10-26", effectiveDate: "2026-10-26", supportEmail: "support@ustal.site", publicOrigin: "https://ustal.site", documents });
    const app = Fastify(); await app.register(routes, { publication });
    try {
      const { body, statusCode } = await app.inject("/delete-account");
      expect(statusCode).toBe(200);
      expect(body.match(/<h1>/g)).toHaveLength(1);
      expect(body).not.toContain("Ким Дмитрий Эдуардович");
      expect(body).not.toContain("Оператор:");
      expect(body).toContain("Контакт: support@ustal.site.");
      const remaining = original.split(/Оператор: Ким Дмитрий Эдуардович, Россия\. /)[1]!;
      const { renderLegalMarkdown } = await import("../legal/markdown.js");
      expect(body).toContain(renderLegalMarkdown(remaining.replace(/\r\n/g, "\n")));
      expect(body).toContain('id="login-form"');
      expect(body).toContain('id="delete-password"');
      expect(body).toContain('/account/delete/client.js');
      expect(renderLegalPage("privacy", publication)).toContain("Оператор: физическое лицо Ким Дмитрий Эдуардович");
    } finally { await app.close(); }
    expect(documents["delete-account"]).toBe(original);
  });
  it("shows one clickable support contact without operator details or raw Markdown", () => {
    const original = readFileSync(new URL("../../../../docs/launch/legal/support.md", import.meta.url), "utf8");
    const documents = Object.fromEntries(Object.keys(titles).map(page => [page, original]));
    const p = validatePublication({ approved: true, version: "2026-10-26", effectiveDate: "2026-10-26", supportEmail: "support@ustal.site", publicOrigin: "https://ustal.site", documents });
    const html = renderLegalPage("support", p);
    expect(html).not.toContain("Оператор:");
    expect(html).not.toContain("Ким Дмитрий Эдуардович");
    expect(html).not.toContain("[support@");
    expect(html.match(/<a href="mailto:support@ustal.site">support@ustal.site<\/a>/g)).toHaveLength(1);
    expect(html.match(/support@ustal.site/g)).toHaveLength(2); // href and visible label only
    expect(html).toContain("Поддержка не является экстренной службой");
    expect(html).toContain("Не включайте пароль, коды, банковские реквизиты");
    expect(documents.support).toBe(original);
  });
  it("starts community rules with one title and the first rule, preserving every rule without the operator block", () => {
    const original = readFileSync(new URL("../../../../docs/launch/legal/community-guidelines.md", import.meta.url), "utf8");
    const documents = Object.fromEntries(Object.keys(titles).map(page => [page, original]));
    const p = validatePublication({ approved: true, version: "2026-10-26", effectiveDate: "2026-10-26", supportEmail: "support@ustal.site", publicOrigin: "https://ustal.site", documents });
    const html = renderLegalPage("community-guidelines", p);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<main><h1>USTAL — Правила сообщества</h1><h2>Уважение и законность</h2>');
    expect(html).not.toMatch(/Оператор:|Ким Дмитрий|support@|mailto:/);
    const remaining = original.replace(/\r\n/g, "\n").split("## Уважение и законность")[1]!;
    expect(html).toContain("Запрещены незаконные товары и услуги");
    expect(html).toContain("Утверждённый срок реакции и правила эскалации должны быть обеспечены перед публичным запуском.");
    expect(html).toContain(renderLegalMarkdown("## Уважение и законность" + remaining));
    expect(documents["community-guidelines"]).toBe(original);
  });
  it("shows one privacy heading while preserving the rest of the approved document", () => {
    const original = readFileSync(new URL("../../../../docs/launch/legal/privacy.md", import.meta.url), "utf8");
    const documents = Object.fromEntries(Object.keys(titles).map(page => [page, original]));
    const p = validatePublication({ approved: true, version: "2026-10-26", effectiveDate: "2026-10-26", supportEmail: "support@ustal.site", publicOrigin: "https://ustal.site", documents });
    const html = renderLegalPage("privacy", p);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain("<h1>USTAL — Политика конфиденциальности</h1>");
    const remaining = original.slice(original.indexOf("\n") + 1);
    expect(html).toContain(renderLegalMarkdown(remaining));
    expect(documents.privacy).toBe(original);
  });
  it("discloses OFF behavior without promising an AI opt-out", () => {
    const html = renderLegalPage("privacy");
    expect(html).toContain("контроль согласия сервером выключен (OFF)");
    expect(html).toContain("отсутствие или отзыв разрешения на этом экране не блокирует передачу");
    expect(html).toContain("Регистрация не считается согласием на AI");
  });
  it("serves all five mobile-friendly pages and same-origin deletion script without auth in preview", async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("USTAL_LEGAL_PUBLICATION_FILE", "");
    const app = Fastify(); await app.register(routes);
    try {
      for (const page of Object.keys(titles)) {
        const r = await app.inject(`/${page}`);
        expect(r.statusCode).toBe(200); expect(r.body).toContain('name="viewport"');
        expect(r.body).not.toContain("<nav");
        expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(r.headers["cache-control"]).toBe("no-store"); expect(r.body).not.toContain("WedLink");
      }
      const deletion = await app.inject("/delete-account");
      expect(deletion.body).toContain('id="delete-password"');
      expect(deletion.body).toContain('id="confirm"');
      expect((await app.inject("/account/delete/client.js")).body).toContain('response.status === 204');
      expect((await app.inject("/legal.css")).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it("never publishes drafts in production and requires an approved bundle", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("USTAL_LEGAL_PUBLICATION_FILE", "");
    const app = Fastify(); await app.register(routes);
    try { expect((await app.inject("/privacy")).statusCode).toBe(404); } finally { await app.close(); }
    const published = Fastify(); await published.register(routes, { publication: approved() });
    try {
      for (const page of Object.keys(titles)) {
        const r = await published.inject(`/${page}`);
        expect(r.statusCode).toBe(200); expect(r.body).not.toMatch(/TBD|\[USTAL_SUPPORT_EMAIL\]|Локальный проект/);
        expect(r.headers["content-type"]).toContain("text/html; charset=utf-8");
        expect(r.body).toContain("<h1>USTAL — ");
      }
      expect((await published.inject("/legal.css")).headers["content-type"]).toContain("text/css");
      expect((await published.inject("/account/delete/client.js")).headers["content-type"]).toContain("application/javascript");
    } finally { await published.close(); }
  });
  it("rejects unfinished publication, unsafe origins and absent explicit approval", () => {
    for (const patch of [{ approved: false }, { effectiveDate: "2026-02-30" }, { supportEmail: "[USTAL_SUPPORT_EMAIL]" }, { processors: "[AI_PROCESSORS_TBD]" }, { retention: "" }, { retention: "НЕОБХОДИМО УТВЕРДИТЬ срок" }, { version: "review-2026-10-26" }, { publicOrigin: "http://ustal.test" }, { publicOrigin: "https://u:password@ustal.test" }]) {
      expect(() => validatePublication({ ...approved(), ...patch })).toThrow();
    }
  });
  it("escapes operator-supplied text and does not invent policy decisions", () => {
    const p = { ...approved(), processors: '<img src=x onerror="alert(1)">' };
    expect(renderLegalPage("privacy", p)).not.toContain("<img");
    expect(renderLegalPage("privacy")).toContain("[BACKUP_RETENTION_TBD]");
    expect(renderLegalPage("delete-account")).toContain("[ACTIVE_WORK_SUPPORT_TBD]");
    expect(renderLegalPage("support", { ...approved(), supportEmail: "help?x=1@ustal.test" })).toContain("mailto:help%3Fx%3D1%40ustal.test");
  });
});
