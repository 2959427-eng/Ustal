import type { FastifyInstance } from "fastify";
import { titles, renderLegalPage, legalCss, type LegalPage } from "../legal/pages.js";
import { currentPublication, type LegalPublication } from "../legal/publication.js";
import { deletionHtml, deletionClient } from "../web/account-deletion.js";

export default async function legalRoutes(app: FastifyInstance, options: { publication?: LegalPublication } = {}) {
  // No production publication is authorized by installing the code. An operator-approved
  // bundle is required; invalid configured bundles fail startup rather than publish drafts.
  const publication = options.publication ?? currentPublication();
  if (process.env.NODE_ENV === "production" && !publication) return;
  const headers = {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  };
  app.get("/legal.css", async (_r, reply) => reply.headers(headers).type("text/css; charset=utf-8").send(legalCss));
  for (const page of Object.keys(titles) as LegalPage[]) {
    app.get(`/${page}`, async (_r, reply) => {
      let html = renderLegalPage(page, publication);
      if (page === "delete-account") {
        const form = deletionHtml.slice(deletionHtml.indexOf('<form id="login-form"'), deletionHtml.indexOf("</main>"));
        html = html.replace("</main>", form + "</main>").replace("</body>", '<script src="/account/delete/client.js" defer></script></body>');
      }
      return reply.headers(headers).type("text/html; charset=utf-8").send(html);
    });
  }
  app.get("/account/delete/client.js", async (_r, reply) => reply.headers(headers).type("application/javascript; charset=utf-8").send(deletionClient));
}
