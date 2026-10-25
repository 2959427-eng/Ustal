import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderLegalMarkdown } from "../legal/markdown.js";
import type { FastifyInstance } from "fastify";

/**
 * Публичные юридические документы (политика ПДн, соглашение, согласие на ИИ-обработку) — один источник для
 * приложения и для страниц App Store / Google Play. Отдаются только утверждённые копии из apps/api/legal/:
 * документ с незаполненными полями ([УКАЗАТЬ) или пометкой ПРОЕКТ не публикуется (404), чтобы проект не попал к людям.
 */
export const LEGAL_DOCUMENTS = ["privacy", "terms", "ai-processing"] as const;
export type LegalDocumentId = (typeof LEGAL_DOCUMENTS)[number];
const LEGAL_DIR = fileURLToPath(new URL("../../legal/", import.meta.url));

export interface LegalDocument { id: LegalDocumentId; version: string; body: string }

export function parseLegalDocument(id: LegalDocumentId, raw: string): LegalDocument | null {
  const text = raw.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const match = /^version:\s*(\d{4}-\d{2}-\d{2})\s*\n/.exec(text);
  if (!match) return null;
  if (/\[УКАЗАТЬ|\[ПРОВЕРИТЬ|ПРОЕКТ/i.test(text)) return null;
  const body = text.slice(match[0].length).trim();
  return body ? { id, version: match[1]!, body } : null;
}

export async function loadLegalDocument(id: LegalDocumentId, dir = LEGAL_DIR): Promise<LegalDocument | null> {
  try { return parseLegalDocument(id, await readFile(`${dir}${id}.md`, "utf8")); } catch { return null; }
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Минимальная разметка без зависимостей: заголовки, списки, абзацы, **жирный**. Весь текст экранируется. */
export function renderLegalHtml(doc: LegalDocument): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>USTAL</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px;color:#111}</style>`
    + `</head><body>${renderLegalMarkdown(doc.body)}<p><small>Версия ${escape(doc.version)}</small></p></body></html>`;
}

export default async function legalRoutes(app: FastifyInstance, opts: { dir?: string } = {}) {
  const load = (id: LegalDocumentId) => loadLegalDocument(id, opts.dir);
  app.get("/legal", async () => ({
    documents: await Promise.all(LEGAL_DOCUMENTS.map(async (id) => {
      const doc = await load(id);
      return { id, available: Boolean(doc), version: doc?.version ?? null, path: `/legal/${id}` };
    })),
  }));
  app.get("/legal/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = (LEGAL_DOCUMENTS as readonly string[]).includes(id) ? await load(id as LegalDocumentId) : null;
    if (!doc) return reply.code(404).send({ error: { code: "legal_document_unavailable", message: "Документ ещё не опубликован" } });
    reply.header("Cache-Control", "public, max-age=300");
    return reply.type("text/html; charset=utf-8").send(renderLegalHtml(doc));
  });
}
