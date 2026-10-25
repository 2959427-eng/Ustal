import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import routes from "./legal.js";
import { validatePublication } from "../legal/publication.js";
import { renderLegalPage, titles } from "../legal/pages.js";

const approved = () => validatePublication({ approved: true, version: "test-only", effectiveDate: "2026-10-21", supportEmail: "support@ustal.test", publicOrigin: "https://ustal.test", agePolicy: "Test fixture age policy", territories: "Test fixture territories", retention: "Test fixture retention", backupRetention: "Test fixture backups", processors: "Test fixture processors", processingLocations: "Test fixture locations", legalBasis: "Test fixture legal basis", activeWorkSupport: "Test fixture manual resolution" });
afterEach(() => vi.unstubAllEnvs());
describe("legal publication boundary", () => {
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
      }
    } finally { await published.close(); }
  });
  it("rejects unfinished publication, unsafe origins and absent explicit approval", () => {
    for (const patch of [{ approved: false }, { effectiveDate: "2026-02-30" }, { supportEmail: "[USTAL_SUPPORT_EMAIL]" }, { processors: "[AI_PROCESSORS_TBD]" }, { retention: "" }, { publicOrigin: "http://ustal.test" }, { publicOrigin: "https://u:password@ustal.test" }]) {
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
