import { z } from "zod";

// Source evidence is checked again by the worker. Keys are suggestions, never new nodes.
export const semanticFactSchema = z.object({
  kind: z.enum(["capability", "resource", "exclude", "availability"]),
  // Normalization-only discriminator; prevents ontology resource nodes from converting
  // software proficiency or a credential into ownership/capacity. Not a DB column.
  subjectType: z.enum(["unspecified", "software_skill", "qualification", "physical_resource", "career_context"]).optional(),
  constraintType: z.enum(["none", "availability", "exclusion", "scope"]),
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
});
export const semanticResultSchema = z.object({
  facts: z.array(semanticFactSchema).max(40),
});
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
