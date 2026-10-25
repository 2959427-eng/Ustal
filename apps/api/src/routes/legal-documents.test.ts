import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import legalRoutes, { parseLegalDocument, renderLegalHtml } from "./legal-documents.js";

const approved = "version: 2026-11-01\n\n# Политика\n\nТекст <script>alert(1)</script> и **важно**.\n\n- пункт\n- второй\n";
async function appWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "legal-")) + "/";
  for (const [name, text] of Object.entries(files)) writeFileSync(dir + name, text);
  const app = Fastify();
  await app.register(legalRoutes, { dir });
  return app;
}

describe("юридические документы", () => {
  it("утверждённый документ отдаётся HTML с версией, текст экранирован", async () => {
    const app = await appWith({ "privacy.md": approved });
    const res = await app.inject("/legal/privacy");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<h1>Политика</h1>");
    expect(res.body).toContain("&lt;script&gt;");
    expect(res.body).not.toContain("<script>");
    expect(res.body).toContain("<strong>важно</strong>");
    expect(res.body).toContain("Версия 2026-11-01");
  });
  it("проект с [УКАЗАТЬ / ПРОЕКТ / без версии не публикуется", async () => {
    const app = await appWith({
      "privacy.md": "version: 2026-11-01\n\nОператор: [УКАЗАТЬ: реквизиты]",
      "terms.md": "version: ПРОЕКТ-2026-10-25\n\nтекст",
      "ai-processing.md": "Без строки версии",
    });
    for (const id of ["privacy", "terms", "ai-processing"]) expect((await app.inject(`/legal/${id}`)).statusCode).toBe(404);
    const list = (await app.inject("/legal")).json();
    expect(list.documents.every((d: { available: boolean }) => !d.available)).toBe(true);
  });
  it("нет файла и неизвестный/обходной id → 404", async () => {
    const app = await appWith({ "privacy.md": approved });
    for (const path of ["/legal/terms", "/legal/..%2Fpackage", "/legal/README", "/legal/privacy.md"])
      expect((await app.inject(path)).statusCode).toBe(404);
  });
  it("список показывает доступность и версии", async () => {
    const app = await appWith({ "privacy.md": approved, "terms.md": approved });
    const docs = (await app.inject("/legal")).json().documents;
    expect(docs).toEqual([
      { id: "privacy", available: true, version: "2026-11-01", path: "/legal/privacy" },
      { id: "terms", available: true, version: "2026-11-01", path: "/legal/terms" },
      { id: "ai-processing", available: false, version: null, path: "/legal/ai-processing" },
    ]);
  });
  it("проекты из docs/legal сейчас не публикуются (ни один не готов)", () => {
    for (const [id, file] of [["privacy", "privacy-policy"], ["terms", "terms"], ["ai-processing", "ai-processing-consent"]] as const) {
      const raw = readFileSync(new URL(`../../../../docs/legal/${file}.md`, import.meta.url), "utf8");
      expect(parseLegalDocument(id, raw)).toBeNull();
    }
  });
  it("CRLF и BOM не мешают", () => {
    const doc = parseLegalDocument("terms", "﻿" + approved.replace(/\n/g, "\r\n"));
    expect(doc?.version).toBe("2026-11-01");
    expect(renderLegalHtml(doc!)).toContain("<li>пункт</li>");
  });
});

describe("API не обращается к ИИ напрямую", () => {
  it("ни один модуль apps/api/src не импортирует провайдеров ИИ — вся передача в ИИ идёт через worker с проверкой согласия", async () => {
    const { readdirSync, readFileSync: read, statSync } = await import("node:fs");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) files.push(p); } };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => /from\s+["']@ustal\/ai["']|getAiProviders|from\s+["']openai["']/.test(read(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
