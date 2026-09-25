export class EvidenceValidationError extends Error {
  readonly code = "EVIDENCE_VALIDATION_ERROR";
  constructor(readonly diagnostic: { field: string; evidence: string; sources: string[] }, message = "Evidence is not grounded in a source span") {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

// A closed lexical normalization, not semantic similarity. Never stem names,
// technologies, subjects or locations. Retain number/unit and polarity tokens.
function tokens(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/\bcan't\b/gu, "cannot")
    .replace(/\b([a-z]+)n't\b/gu, "$1 not")
    .replace(/−/gu, "-")
    .replace(/<=|≤/gu, " limitmax ").replace(/>=|≥/gu, " limitmin ")
    .replace(/</gu, " strictmax ").replace(/>/gu, " strictmin ")
    .replace(/%/gu, " percent ")
    .replace(/^i\s+(?=can\b|cannot\b|am\b)/u, "")
    .replace(/\b(?:no more than|at most|a maximum of|maximum)\b|не более|максимум/gu, " limitmax ")
    .replace(/\b(?:no less than|at least|a minimum of|minimum)\b|не менее|минимум/gu, " limitmin ")
    .replace(/\bonly\b|только|исключительно/gu, " scopeonly ")
    .replace(/(\d)[,.](\d)/gu, "$1.$2")
    .replace(/(\d)(kg|кг|grams|грамм|км|km|g|г|м|m|слов|words|wpm)(?=$|[^\p{L}])/gu, "$1 $2")
    .match(/[+-]?[\p{L}\p{N}]+(?:[.+#:/-][\p{L}\p{N}]+)*[+#]*/gu) ?? []);
}
const polarity = new Set(["no", "not", "without", "cannot", "never", "unable", "refuse", "refusal", "except", "excluding", "prohibited", "exclusively", "не", "нет", "без", "нельзя", "отказ", "отказываюсь", "кроме", "исключая", "запрещено", "limitmax", "limitmin", "strictmax", "strictmin", "scopeonly", "before", "after", "until", "до", "после"]);
const units = new Set(["kg", "g", "кг", "г", "grams", "грамм", "км", "km", "м", "m", "percent", "км/ч", "km/h", "слов/мин", "words/min", "wpm"]);
const important = (words: string[]) => words.filter(word => /\d/u.test(word) || polarity.has(word) || units.has(word));
const same = (a: string[], b: string[]) => a.length === b.length && a.every((word, i) => word === b[i]);

function spans(source: string): string[] {
  // JSON inputs are compared within leaf values first, avoiding accidental joins
  // of unrelated fields. Full JSON remains available for an actual full quote.
  try {
    const leaves: string[] = [];
    const visit = (value: unknown) => {
      if (typeof value === "string" || typeof value === "number") leaves.push(String(value));
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => {
        // A quoted JSON field is a local fact: numbers in a sibling field must
        // not invalidate it. Retain its key so it is also a valid literal span.
        leaves.push(JSON.stringify({ [key]: item }));
        visit(item);
      });
    };
    visit(JSON.parse(source));
    return [...leaves, source];
  } catch {
    return [...source.split(/[\n;!?]|\.(?=\s|$)/u).filter(Boolean), source];
  }
}

/** String/number leaf values of a JSON source (or the text itself when not JSON). */
export function sourceLeaves(source: string): string[] {
  try {
    const leaves: string[] = [];
    const visit = (value: unknown) => {
      if (typeof value === "string" || typeof value === "number") leaves.push(String(value));
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(JSON.parse(source));
    return leaves;
  } catch {
    return [source];
  }
}

export function isGroundedEvidence(evidence: string, sources: string[]): boolean {
  const quote = tokens(evidence);
  if (!quote.length) return false;
  return sources.some(source => spans(source).some(span => {
    const words = tokens(span);
    // Even literal excerpts must not silently omit a negation, exclusive scope
    // or numeric fact from their enclosing value/sentence.
    if (!same(important(quote), important(words))) return false;
    return words.some((_, start) => same(quote, words.slice(start, start + quote.length)));
  }));
}

export function assertGroundedEvidence(evidence: string, sources: string[], field: string): void {
  if (!isGroundedEvidence(evidence, sources)) throw new EvidenceValidationError({ field, evidence, sources });
}
