import { z } from "zod";

// Source evidence is checked again by the worker. Keys are suggestions, never new nodes.
export const semanticFactSchema = z.object({
  kind: z.enum(["capability", "resource", "exclude", "availability"]),
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
  compatible: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(600),
});
export interface OntologyOption {
  canonicalKey: string;
  name: string;
  nodeType: string;
  description: string | null;
  synonyms?: string[];
}
