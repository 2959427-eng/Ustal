import { z } from "zod";

// Source evidence is checked again by the worker. Keys are suggestions, never new nodes.
export const semanticFactSchema = z.object({
  kind: z.enum(["capability", "resource", "exclude", "availability"]),
  // Normalization-only discriminator; prevents ontology resource nodes from converting
  // software proficiency or a credential into ownership/capacity. Not a DB column.
  subjectType: z.enum(["unspecified", "software_skill", "qualification", "physical_resource", "career_context"]).optional(),
  // "lift" (profiles only): an explicit later statement that removes/relaxes an earlier restriction
  // («теперь работаю после 22:00»). Resolved by the worker and never persisted or matched.
  constraintType: z.enum(["none", "availability", "exclusion", "scope", "lift"]),
  constraintScope: z.enum(["whole_task", "fact", "optional_component"]),
  resourceRole: z.enum(["none", "available", "required", "provided_by_customer", "missing", "compatibility"]),
  resourceCapacity: z.object({
    value: z.number().nullable(),
    unit: z.string().nullable(),
    kind: z.string().nullable(),
  }),
  phrase: z.string().min(1).max(300),
  evidence: z.string().min(1).max(1000),
  canonicalKeys: z.array(z.string().max(100)).max(4),
  confidence: z.number().min(0).max(1),
  mandatory: z.boolean(),
  // Local wall-clock time in the order's city. Null means unspecified, not unrestricted.
  startHour: z.number().int().min(0).max(23).nullable(),
  endHour: z.number().int().min(1).max(24).nullable(),
  // Local day-of-week in the order's city, ISO weekday numbering: 0=Mon..6=Sun.
  // Null/omitted means unspecified (no day-of-week restriction), not "every day".
  // Independent of startHour/endHour: both gates apply when both are present.
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).nullable(),
  // Profiles only, refusal facts only (2026-10-06): what the refusal does to an existing skill.
  // "revoke" — the person removes an activity earlier stated as their skill from the active profile;
  // "restriction" — the skill stays, only such orders are not taken now / under conditions / a narrower part.
  // Resolved by the worker against the existing skills; absent/null = restriction (never deletes a skill).
  refusalIntent: z.enum(["revoke", "restriction"]).nullable().optional(),
  // Profiles only (2026-10-15). label — short normalized display name of the item («Перевозка людей»,
  // «Автобус»); phrase keeps the user's wording for matching. attributes — descriptive properties of an owned
  // resource; never read by matching. itemRef — CURRENT_PROFILE id of the same existing item (update mode);
  // a proposal the server verifies, never a command.
  label: z.string().max(120).nullable().optional(),
  attributes: z.array(z.object({
    key: z.string().min(1).max(60),
    value: z.union([z.number(), z.string().min(1).max(120)]),
    unit: z.string().max(20).nullable(),
  })).max(12).optional(),
  itemRef: z.string().max(20).nullable().optional(),
});
export const semanticResultSchema = z.object({
  facts: z.array(semanticFactSchema).max(40),
  // Profile update by one message (2026-10-13): ids of CURRENT_PROFILE items the new message cancels.
  // Only present when the normalization was given the current profile; the worker applies it.
  removes: z.array(z.string().max(20)).max(40).optional(),
});
/** One item of the current profile shown to normalization when a new profile message is processed. */
export interface ProfileItemOption {
  id: string;
  type: "skill" | "resource" | "no_resource" | "refusal" | "removed_skill" | "time_limit" | "only_scope";
  phrase: string;
  label?: string;
  attributes?: { key: string; value: string | number; unit: string | null }[];
  hours?: string;
}
export type SemanticFact = z.infer<typeof semanticFactSchema>;
export type SemanticResult = z.infer<typeof semanticResultSchema>;
export const semanticReviewSchema = z.object({
  // An evidence inventory, separate from the model's relevance opinion. The server
  // compares known values; absent values never prove incompatibility.
  numericLimits: z.array(z.object({
    profileEvidence: z.string().min(1).max(1000),
    orderEvidence: z.string().min(1).max(1000),
    metric: z.string().min(1).max(100),
    available: z.number().finite().nonnegative().nullable(),
    required: z.number().finite().nonnegative().nullable(),
    availableUnit: z.string().min(1).max(80).nullable(),
    requiredUnit: z.string().min(1).max(80).nullable(),
    // Factual property type, not a feasibility opinion. The server decides the conflict.
    limitKind: z.enum(["rate", "threshold", "per_item", "total_quantity"]),
    // Verbatim order text explicitly requiring one trip/batch/indivisible execution; else null.
    wholeTaskEvidence: z.string().min(1).max(1000).nullable(),
  })).max(8).optional(),
  exclusiveScope: z.object({
    profileEvidence: z.string().min(1).max(1000),
    orderEvidence: z.string().min(1).max(1000),
    allowed: z.array(z.string().min(1).max(100)).min(1).max(8),
    // Null when the order does not state this dimension at all (no conflict).
    requested: z.string().min(1).max(100).nullable(),
    requestedWithinAllowed: z.boolean(),
  }).nullable().optional(),
  // Optional for existing mock/recorded adapters; required (nullable) in the live contract.
  hardConflict: z.object({
    kind: z.enum(["scope", "location", "exclusion", "resource", "eligibility", "numeric", "domain"]),
    profileEvidence: z.string().min(1).max(1000),
    orderEvidence: z.string().min(1).max(1000),
  }).nullable().optional(),
  compatible: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(600),
});
export type SemanticReview = z.infer<typeof semanticReviewSchema>;
// Focused check of an exclusion hardConflict: does the order request / require the refused thing?
export const refusalVerdictSchema = z.object({ involves: z.boolean(), reason: z.string().max(400) });
export interface OntologyOption {
  canonicalKey: string;
  name: string;
  nodeType: string;
  description: string | null;
  synonyms?: string[];
}
