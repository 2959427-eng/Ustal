import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderLegalMarkdown } from "../legal/markdown.js";
import { renderLegalPage } from "../legal/pages.js";
import { currentPublication, type LegalPublication } from "../legal/publication.js";
import type { FastifyInstance } from "fastify";

/**
 * Политика и соглашение используют ту же утверждённую publication, что /privacy и /terms.
 * /legal и старые адреса /legal/:id сохранены для выпущенных мобильных сборок.
 * Источник отдельного AI-документа не меняется этой правкой.
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

export default async function legalRoutes(app: FastifyInstance, opts: { dir?: string; publication?: LegalPublication } = {}) {
  const publication = opts.publication ?? currentPublication();
  const load = (id: LegalDocumentId) => loadLegalDocument(id, opts.dir);
  const list = async () => ({
    documents: await Promise.all(LEGAL_DOCUMENTS.map(async (id) => {
      if (id === "privacy" || id === "terms") {
        return { id, available: Boolean(publication), version: publication?.version ?? null, path: `/legal/${id}` };
      }
      const doc = await load(id);
      return { id, available: Boolean(doc), version: doc?.version ?? null, path: `/legal/${id}` };
    })),
  });
  for (const path of ["/legal", "/legal/"]) app.get(path, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return list();
  });
  app.get("/legal/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if ((id === "privacy" || id === "terms") && publication) {
      return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(renderLegalPage(id, publication));
    }
    const doc = id === "ai-processing" ? await load(id) : null;
    if (!doc) return reply.code(404).send({ error: { code: "legal_document_unavailable", message: "Документ ещё не опубликован" } });
    reply.header("Cache-Control", "public, max-age=300");
    return reply.type("text/html; charset=utf-8").send(renderLegalHtml(doc));
  });
}
