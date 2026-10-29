import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import publicPages from "../src/routes/legal.js";
import documentRoutes from "../src/routes/legal-documents.js";
import { publicationPages } from "../src/legal/publication.js";
import { registrationDocumentsReady, registrationConsentError } from "../../mobile/src/lib/registration-consent.js";

afterEach(() => vi.unstubAllEnvs());

const bundle = () => ({
  approved: true, version: "2026-10-29", effectiveDate: "2026-10-29",
  supportEmail: "support@ustal.test", publicOrigin: "https://ustal.test",
  documents: Object.fromEntries(publicationPages.map(page => [page, `## Approved ${page}\n\nExact approved fixture text.`])),
});

async function appWithPublication(publication?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "ustal-publication-regression-"));
  const path = join(directory, "publication.json");
  if (publication) writeFileSync(path, JSON.stringify(publication));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("USTAL_LEGAL_PUBLICATION_FILE", publication ? path : "");
  const app = Fastify();
  await app.register(publicPages);
  // No Markdown documents exist here: registration must use the publication bundle.
  await app.register(documentRoutes, { dir: directory + "/" });
  return app;
}

describe("publication pages → compatibility metadata → existing mobile registration gate", () => {
  it("one approved bundle publishes the pages, reports them available and unblocks registration", async () => {
    const app = await appWithPublication(bundle());
    try {
      for (const id of ["privacy", "terms"])
        expect((await app.inject(`/${id}`)).statusCode).toBe(200);
      const result = await app.inject("/legal");
      expect(result.statusCode).toBe(200);
      const { documents } = result.json();
      expect(documents).toEqual([
        { id: "privacy", available: true, version: "2026-10-29", path: "/legal/privacy" },
        { id: "terms", available: true, version: "2026-10-29", path: "/legal/terms" },
        { id: "ai-processing", available: false, version: null, path: "/legal/ai-processing" },
      ]);
      const input = { documentsReady: registrationDocumentsReady(documents), allowUnpublished: false, acceptedRules: true, acceptedPdn: true };
      expect(input.documentsReady).toBe(true);
      expect(registrationConsentError(input)).toBeNull();
      expect(registrationConsentError({ ...input, acceptedRules: false })).not.toBeNull();
      expect(registrationConsentError({ ...input, acceptedPdn: false })).not.toBeNull();
      expect(result.headers["cache-control"]).toBe("no-store");
      expect((await app.inject("/legal/")).body).toBe(result.body);
      for (const id of ["privacy", "terms"]) {
        const canonical = await app.inject(`/${id}`);
        const alias = await app.inject(`/legal/${id}`);
        expect(canonical.body).toContain(`Approved ${id}`);
        expect(alias.statusCode).toBe(200);
        expect(alias.body).toBe(canonical.body);
      }
    } finally { await app.close(); }
  });

  it("missing publication keeps production pages unavailable and registration blocked", async () => {
    const app = await appWithPublication();
    try {
      for (const path of ["/privacy", "/terms", "/legal/privacy", "/legal/terms"])
        expect((await app.inject(path)).statusCode).toBe(404);
      const response = await app.inject("/legal/");
      expect(response.statusCode).toBe(200);
      const { documents } = response.json();
      const documentsReady = registrationDocumentsReady(documents);
      expect(documentsReady).toBe(false);
      expect(registrationConsentError({ documentsReady, allowUnpublished: false, acceptedRules: true, acceptedPdn: true })).toContain("не опубликованы");
    } finally { await app.close(); }
  });

  it("an unapproved bundle still fails validation instead of unlocking registration", async () => {
    await expect(appWithPublication({ ...bundle(), approved: false })).rejects.toThrow("explicit approval");
  });
});
