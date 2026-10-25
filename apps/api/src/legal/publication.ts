import { readFileSync } from "node:fs";

export interface LegalPublication {
  approved: true;
  version: string;
  effectiveDate: string;
  supportEmail: string;
  publicOrigin: string;
  agePolicy: string;
  territories: string;
  retention: string;
  backupRetention: string;
  processors: string;
  processingLocations: string;
  legalBasis: string;
  activeWorkSupport: string;
}

const fields = ["version", "effectiveDate", "supportEmail", "publicOrigin", "agePolicy", "territories", "retention", "backupRetention", "processors", "processingLocations", "legalBasis", "activeWorkSupport"] as const;
export function validatePublication(value: unknown): LegalPublication {
  if (!value || typeof value !== "object") throw new Error("Legal publication must be an approved object");
  const v = value as Record<string, unknown>;
  if (v.approved !== true) throw new Error("Legal publication requires explicit approval");
  for (const key of fields) {
    if (typeof v[key] !== "string" || !(v[key] as string).trim() || /\bTBD\b|\[[A-Z_]+\]|placeholder|example\.(com|org|net)|черновик|не утвержден/iu.test(v[key] as string))
      throw new Error(`Legal publication field is not finalized: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.effectiveDate as string) || !Number.isFinite(Date.parse(v.effectiveDate as string)) || new Date(v.effectiveDate as string).toISOString().slice(0, 10) !== v.effectiveDate) throw new Error("Invalid legal effective date");
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(v.supportEmail as string)) throw new Error("Invalid support email");
  const url = new URL(v.publicOrigin as string);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) throw new Error("Public legal origin must be an approved HTTPS origin");
  return Object.freeze(Object.fromEntries(["approved" as const, ...fields].map(k => [k, v[k]]))) as unknown as LegalPublication;
}

export function loadPublication(): LegalPublication | undefined {
  const path = process.env.USTAL_LEGAL_PUBLICATION_FILE;
  return path ? validatePublication(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}
