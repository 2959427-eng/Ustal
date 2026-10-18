import { z } from "zod";

/**
 * Phase 1 profile_facts (SHADOW MODE, claude/extended-ai-profile-architecture-2026-09-27.md).
 *
 * One universal fact shape instead of a DB column per life fact. `factType` is an open-ended code-level
 * registry (DB column is varchar): adding a type is a code change, never a migration.
 * - slot "single": one current value per user (a newer statement supersedes the older one);
 * - slot "multi": one current value per user AND normalized label (languages, roles, skills ...).
 * - requires: which value field must be present for the fact to be meaningful.
 */
export const PROFILE_FACT_TYPES = {
  skill: { slot: "multi", requires: "label" },
  resource: { slot: "multi", requires: "label" },
  experience: { slot: "multi", requires: "number" }, // work experience (label = role/field if stated); number = duration
  role: { slot: "multi", requires: "label" }, // job title held (timeframe current/past)
  industry: { slot: "multi", requires: "label" },
  education: { slot: "multi", requires: "label" },
  management: { slot: "multi", requires: "number" }, // managed people; number = team size, label = unit if stated
  responsibility: { slot: "multi", requires: "label" }, // scope of responsibility (budget, region, P&L ...)
  achievement: { slot: "multi", requires: "label" },
  language: { slot: "multi", requires: "label" }, // level = stated level
  certification: { slot: "multi", requires: "label" }, // licences, permits, credentials
  work_preference: { slot: "multi", requires: "label" },
  desired_role: { slot: "multi", requires: "label" },
  compensation: { slot: "single", requires: "number" }, // expected pay; unit = currency, period
  schedule: { slot: "single", requires: "label" },
  location: { slot: "single", requires: "label" }, // where the person lives/works
  relocation: { slot: "single", requires: "flag" },
  travel: { slot: "single", requires: "flag" }, // business trips / shift work willingness
  restriction: { slot: "multi", requires: "label" }, // explicit "не делаю / не беру / не работаю с"
  job_search: { slot: "single", requires: "label" }, // active / passive / not looking
  other: { slot: "multi", requires: "label" },
} as const satisfies Record<string, { slot: "single" | "multi"; requires: "label" | "number" | "flag" }>;
export type ProfileFactType = keyof typeof PROFILE_FACT_TYPES;
export const PROFILE_FACT_TYPE_NAMES = Object.keys(PROFILE_FACT_TYPES) as [ProfileFactType, ...ProfileFactType[]];

/** Normalized value: generic, typed fields; unused ones are null. */
export const profileFactValueSchema = z.object({
  label: z.string().min(1).max(200).nullable(),
  number: z.number().finite().nullable(),
  numberMax: z.number().finite().nullable(),
  unit: z.string().min(1).max(40).nullable(),
  period: z.enum(["hour", "day", "week", "month", "year"]).nullable(),
  level: z.string().min(1).max(40).nullable(),
  flag: z.boolean().nullable(),
  timeframe: z.enum(["current", "past", "future"]).nullable(),
  approximate: z.boolean(),
});
export type ProfileFactValue = z.infer<typeof profileFactValueSchema>;

/** AI contract of the separate profile-facts extraction (never the frozen matching prompts). */
export const extractedProfileFactSchema = z.object({
  factType: z.enum(PROFILE_FACT_TYPE_NAMES),
  // Verbatim fragment of THIS source input; the server verifies it and drops the fact otherwise.
  evidence: z.string().min(1).max(500),
  value: profileFactValueSchema,
  assertion: z.enum(["explicit", "inferred"]),
  confidence: z.number().min(0).max(1),
  // Special-category personal data (health, religion, politics, ...). Such facts are never stored.
  sensitive: z.boolean(),
});
export const profileFactsExtractionSchema = z.object({
  facts: z.array(extractedProfileFactSchema).max(40),
});
export type ExtractedProfileFact = z.infer<typeof extractedProfileFactSchema>;
export type ProfileFactsExtraction = z.infer<typeof profileFactsExtractionSchema>;

// ---------------------------------------------------------------------------
// Phase 2A: shared rules used by the worker (AI output) and the owner API (user corrections).
// ---------------------------------------------------------------------------

const foldText = (s: string) => s.normalize("NFKC").toLowerCase().replace(/ё/g, "е");

/** Conflict identity: single-valued types have one slot per user; multi-valued ones per normalized label. */
export function profileFactSlotKey(factType: ProfileFactType, value: Pick<ProfileFactValue, "label">): string {
  if (PROFILE_FACT_TYPES[factType].slot === "single") return factType;
  const label = foldText(value.label ?? "").replace(/[^\p{L}\p{N}+# ]+/gu, " ").replace(/\s+/gu, " ").trim();
  return `${factType}:${label}`.slice(0, 200);
}

/**
 * Special-category personal data (152-ФЗ ст.10 and similar): health, disability, pregnancy, religion,
 * politics, ethnicity/race, sexual life/orientation, criminal record, union membership. A privacy safety
 * net on top of the model's `sensitive` flag: a fact whose evidence or value mentions such a category is
 * never stored, so the model must quote only the safe part ("тяжести не поднимаю", not "диабет").
 * Conservative word-start stems; false positives only drop a fact (never store more than intended).
 */
const SENSITIVE_STEMS = [
  // health / disability / pregnancy
  "диабет", "астм", "гипертон", "инсульт", "инфаркт", "эпилеп", "онколог", "рак ", "опухол", "вич", "спид",
  "гепатит", "туберкул", "беремен", "инвалид", "депресс", "психиатр", "шизофр", "биполяр", "аутизм", "диагноз",
  "болезн", "болею", "заболеван", "грыж", "травм", "лечусь", "лечение", "химиотерап", "протез", "слепот",
  "глух", "алкогол", "наркот", "зависимост",
  // religion
  "религ", "верующ", "православ", "мусульман", "ислам", "христиан", "иудей", "буддист", "католи", "протестант",
  "намаз", "атеист",
  // politics / union
  "партии", "партия", "политическ", "оппозиц", "профсоюз",
  // ethnicity / race / sexual life / criminal record
  "национальност", "этническ", "раса ", "расов", "гей", "лесби", "бисексу", "трансгендер", "ориентаци",
  "судим", "тюрьм", "колони", "отбывал", "уголовн",
];
export function mentionsSensitiveCategory(text: string): boolean {
  const t = ` ${foldText(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return SENSITIVE_STEMS.some((stem) => t.includes(` ${stem}`));
}

/**
 * Evaluative personal qualities ("сильный лидер", "ответственный", "стрессоустойчивый"). They are never
 * produced by inference; an explicit self-description is kept only as the person's own words.
 */
const TRAIT_STEMS = [
  "лидер", "ответствен", "стрессоустойчив", "коммуникабел", "пунктуал", "трудолюб", "надежн", "честн",
  "целеустремл", "креативн", "инициативн", "организованн", "усидчив", "аккуратн", "внимательн", "обучаем",
  "харизм", "дисциплинир", "добросовест", "порядочн", "умн", "талантлив", "исполнительн",
];
const TRAIT_FILLERS = new Set(["я", "очень", "сильный", "сильная", "хороший", "хорошая", "отличный", "отличная", "прирожденный", "человек", "и"]);
/** True when the label is ONLY an evaluative quality ("сильный лидер", "ответственный"), not a role/scope
 * that merely contains such a word ("ответственный за закупки", "исполнительный директор", "лидер продаж"). */
export function isEvaluativeTrait(label: string): boolean {
  const words = foldText(label).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const core = words.filter((w) => !TRAIT_FILLERS.has(w));
  return core.length > 0 && core.every((w) => TRAIT_STEMS.some((stem) => w.startsWith(stem)));
}

/** Inferred facts are cautious structural readings: their stored confidence is capped. */
export const INFERRED_CONFIDENCE_CAP = 0.6;

export const PROFILE_FACT_VISIBILITIES = ["private", "shareable"] as const;
export type ProfileFactVisibility = (typeof PROFILE_FACT_VISIBILITIES)[number];

/** PATCH /profile/facts/:id — owner correction: a partial value merged over the current effective value. */
export const correctProfileFactSchema = z.object({
  value: profileFactValueSchema.partial().refine((v) => Object.keys(v).length > 0, { message: "Нужно указать хотя бы одно поле" }),
});
export const profileFactVisibilitySchema = z.object({ visibility: z.enum(PROFILE_FACT_VISIBILITIES) });
export const profileFactIdParamSchema = z.object({ id: z.string().uuid() });
export const profileFactSourceParamSchema = z.object({ sourceInputId: z.string().uuid() });
/** GET /profile/facts: current = active + superseded; all = also revoked (replaced rows stay internal). */
export const profileFactsListQuerySchema = z.object({ include: z.enum(["current", "all"]).default("current") });
