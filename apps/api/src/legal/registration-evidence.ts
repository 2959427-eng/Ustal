import { createHash } from "node:crypto";
import { renderLegalPage } from "./pages.js";
import type { LegalPublication } from "./publication.js";

/**
 * Доказательство принятия документов при регистрации: версия и дата публикации плюс SHA-256 ровно тех страниц
 * /terms и /privacy, которые были опубликованы в момент регистрации. Без публикации — явная отметка published=false.
 */
export function registrationDocumentEvidence(publication: LegalPublication | undefined) {
  if (!publication) return { published: false as const, version: null, effectiveDate: null, termsSha256: null, privacySha256: null };
  const sha = (page: "terms" | "privacy") => createHash("sha256").update(renderLegalPage(page, publication)).digest("hex");
  return { published: true as const, version: publication.version, effectiveDate: publication.effectiveDate, termsSha256: sha("terms"), privacySha256: sha("privacy") };
}
