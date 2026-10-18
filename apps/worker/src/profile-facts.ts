import {
  INFERRED_CONFIDENCE_CAP,
  isEvaluativeTrait,
  mentionsSensitiveCategory,
  profileFactSlotKey,
  PROFILE_FACT_TYPES,
  type ExtractedProfileFact,
  type ProfileFactType,
  type ProfileFactValue,
} from "@ustal/validation";

/**
 * Phase 1 profile_facts (SHADOW) — pure server-side rules. The AI output is never trusted as is:
 * every fact must quote THIS source input verbatim, its label/numbers must be supported by that quote,
 * special-category data is discarded, and conflict identity (slot_key) is computed here, not by the model.
 */

/** Largest source accepted for extraction (API caps profile text at 4000; transcripts may be longer). */
export const MAX_PROFILE_FACTS_SOURCE_CHARS = 8000;

export type RejectReason =
  | "evidence_not_in_source"
  | "label_not_supported"
  | "number_not_supported"
  | "missing_required_value"
  | "invalid_job_search_label"
  | "sensitive"
  | "sensitive_evidence"
  | "inferred_trait"
  | "duplicate_slot";

export interface AcceptedFact {
  factType: ProfileFactType;
  slotKey: string;
  value: ProfileFactValue;
  /** The exact original substring of the source input. */
  evidence: string;
  assertion: "explicit" | "inferred";
  confidence: number;
}

const fold = (c: string) => c.normalize("NFKC").toLowerCase().replace(/ё/g, "е");
const isSpace = (c: string) => /\s/u.test(c);
const trimQuotes = (s: string) => s.trim().replace(/^[\s"'«»„“”.,;:!?()-]+|[\s"'«»„“”.,;:!?()-]+$/gu, "");

/**
 * Finds `quote` inside `source` ignoring case, ё/е and whitespace runs, and returns the ORIGINAL
 * substring of the source, so the stored evidence is always a real part of the user's message.
 */
export function locateEvidence(source: string, quote: string): string | null {
  const q = trimQuotes(quote);
  if (q.length < 2) return null;
  // Normalized source with a map back to original indices.
  let norm = "";
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (isSpace(ch)) {
      if (prevSpace || norm.length === 0) continue;
      norm += " "; map.push(i); prevSpace = true;
    } else {
      const f = fold(ch);
      for (const c of f) { norm += c; map.push(i); }
      prevSpace = false;
    }
  }
  const nq = fold(q).replace(/\s+/gu, " ");
  const at = norm.indexOf(nq);
  if (at < 0) return null;
  const start = map[at]!;
  const end = map[at + nq.length - 1]! + 1;
  return source.slice(start, end);
}

const words = (s: string) => fold(s).split(/[^\p{L}\p{N}+#]+/u).filter((w) => w.length >= 2);

/**
 * A label must be grounded lexically in its own evidence (not in the rest of the message): at least one
 * label word shares a stem (first min(len,4) chars) with an evidence word. Blocks invented enrichment
 * such as industry="ритейл" quoted from "был коммерческим директором".
 */
export function labelSupported(label: string, evidence: string): boolean {
  const ev = words(evidence);
  return words(label).some((w) => {
    // 4-letter stems tolerate Russian inflection/derivation (поднимаю ~ поднятие, водить ~ вождение is
    // still not matched: such labels must reuse the person's own word).
    const stem = w.slice(0, Math.min(w.length, 4));
    return ev.some((e) => e.startsWith(stem) || (e.length >= 4 && w.startsWith(e.slice(0, 4))));
  });
}

/**
 * Numbers in the value must come from the evidence when the evidence states digits ("300" -> 300,
 * "500 тыс." -> 500000, "1,5 млн" -> 1500000). Evidence without digits (word numerals: "четыре года")
 * is accepted as is. Blocks invented figures such as revenue=1e9 quoted from "управлял отделом".
 */
export function numbersSupported(value: ProfileFactValue, evidence: string): boolean {
  const nums = [...evidence.matchAll(/\d+(?:[.,]\d+)?/gu)].map((m) => Number(m[0].replace(",", ".")));
  if (!nums.length) return true;
  const e = fold(evidence);
  const scales = [1, ...(/(тыс|\bk\b|\bк\b)/u.test(e) ? [1_000] : []), ...(/(млн|million)/u.test(e) ? [1_000_000] : [])];
  const ok = (n: number | null) => n === null || nums.some((d) => scales.some((k) => Math.abs(d * k - n) < 1e-6));
  return ok(value.number) && ok(value.numberMax);
}

/**
 * The sentence(s) of the source that contain the evidence. A label may name something stated in the
 * same sentence ("директором завода 7 лет" -> experience label "директор завода" quoted as "7 лет"),
 * but never something absent from that sentence (industry="ритейл").
 */
export function enclosingSentences(source: string, evidence: string): string {
  const at = source.indexOf(evidence);
  if (at < 0) return evidence;
  const boundary = /[.!?;\n]/u;
  let start = at, end = at + evidence.length;
  while (start > 0 && !boundary.test(source[start - 1]!)) start--;
  while (end < source.length && !boundary.test(source[end]!)) end++;
  return source.slice(start, end);
}

const NEGATION = /(^|[^\p{L}])(не|нет|без|ни)(?=[^\p{L}]|$)/iu;
const LEADING_CONNECTOR = /^(?:поэтому|так как|потому что|т\.к\.|из-за этого|но|а|и)\s+/iu;

/**
 * "У меня диабет, поэтому тяжести не поднимаю" -> "тяжести не поднимаю". Splits the quote on clause
 * punctuation/causal connectors and returns the single clause that carries no special-category data yet
 * still states the fact (keeps the quote's negation, numbers and label). null when none or ambiguous.
 */
export function safeClause(evidence: string, value: ProfileFactValue, source: string): string | null {
  const parts = evidence.split(/[,;:()]|\s(?:поэтому|так как|потому что|т\.к\.)\s/iu)
    .map((p) => p.trim().replace(LEADING_CONNECTOR, "").trim()).filter((p) => p.length >= 3);
  const negated = NEGATION.test(evidence);
  const ok = parts.filter((p) =>
    !mentionsSensitiveCategory(p) && (!negated || NEGATION.test(p)) && numbersSupported(value, p) &&
    (!value.label || labelSupported(value.label, p)) && source.includes(p));
  return ok.length === 1 ? ok[0]! : null;
}

const JOB_SEARCH = new Set(["active", "passive", "not_looking"]);

/** Conflict identity (shared with the owner API): see @ustal/validation profileFactSlotKey. */
export const slotKeyFor = profileFactSlotKey;

export function validateExtractedFacts(source: string, facts: ExtractedProfileFact[]): {
  accepted: AcceptedFact[];
  rejected: Partial<Record<RejectReason, number>>;
} {
  const accepted: AcceptedFact[] = [];
  const rejected: Partial<Record<RejectReason, number>> = {};
  const reject = (r: RejectReason) => { rejected[r] = (rejected[r] ?? 0) + 1; };
  const slots = new Set<string>();
  for (const f of facts) {
    if (f.sensitive) { reject("sensitive"); continue; }
    let evidence = locateEvidence(source, f.evidence);
    if (!evidence) { reject("evidence_not_in_source"); continue; }
    // Privacy net: the stored fact (evidence and value) must not carry special-category data. The model is
    // asked to quote only the safe part ("тяжести не поднимаю"); if it quoted the cause too, keep the one
    // safe clause of the quote when it alone still states the fact, otherwise drop the fact.
    if (mentionsSensitiveCategory(`${f.value.label ?? ""} ${f.value.level ?? ""} ${f.value.unit ?? ""}`)) { reject("sensitive_evidence"); continue; }
    if (mentionsSensitiveCategory(evidence)) {
      const safe = safeClause(evidence, f.value, source);
      if (!safe) { reject("sensitive_evidence"); continue; }
      evidence = safe;
    }
    // Evaluative qualities are never inferred ("сильный лидер" from "руководил 300 людьми").
    if (f.assertion === "inferred" && f.value.label && isEvaluativeTrait(f.value.label)) { reject("inferred_trait"); continue; }
    const needs = PROFILE_FACT_TYPES[f.factType].requires;
    if ((needs === "label" && !f.value.label) || (needs === "number" && f.value.number === null) ||
        (needs === "flag" && f.value.flag === null)) { reject("missing_required_value"); continue; }
    if (f.factType === "job_search") {
      if (!JOB_SEARCH.has(f.value.label ?? "")) { reject("invalid_job_search_label"); continue; }
    } else if (f.value.label && !labelSupported(f.value.label, enclosingSentences(source, evidence))) { reject("label_not_supported"); continue; }
    if (!numbersSupported(f.value, evidence)) { reject("number_not_supported"); continue; }
    const slotKey = slotKeyFor(f.factType, f.value);
    if (slots.has(slotKey)) { reject("duplicate_slot"); continue; }
    slots.add(slotKey);
    // Model confidence never lifts an inferred reading into a high-trust fact.
    const confidence = f.assertion === "inferred" ? Math.min(f.confidence, INFERRED_CONFIDENCE_CAP) : f.confidence;
    accepted.push({ factType: f.factType, slotKey, value: f.value, evidence, assertion: f.assertion, confidence });
  }
  return { accepted, rejected };
}

// Slot resolution (precedence corrected > confirmed > AI, then later message) lives in @ustal/database so the
// worker and the owner API share one implementation.
export { planSlotResolution, type SlotCandidate } from "@ustal/database";
