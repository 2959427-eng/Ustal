import { z } from "zod";
import { ruPhoneSchema } from "./auth.js";

/** PATCH /profile — точечные правки без AI (см. docs/api.md). */
export const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    cityId: z.string().uuid().optional(),
    whatsappPhone: ruPhoneSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Нужно указать хотя бы одно поле" });
export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;

export const profileInputSchema = z.object({
  inputType: z.enum(["text", "voice"]),
  text: z.string().min(1).max(4000).optional(),
  audioMediaId: z.string().uuid().optional(),
}).refine((v) => (v.inputType === "text" ? !!v.text : !!v.audioMediaId), {
  message: "text обязателен для inputType=text, audioMediaId — для inputType=voice",
});
export type ProfileInputRequest = z.infer<typeof profileInputSchema>;

// JSON Schema, которую обязана вернуть StructuredExtractionProvider для профиля.
// LLM никогда не пишет в БД напрямую — этот же контракт валидирует ответ AI
// перед ontology mapping (см. docs/architecture.md, packages/ai).
export const capabilityExtractionResultSchema = z.object({
  summary: z.string(),
  capabilities: z.array(
    z.object({
      label: z.string(),
      proficiency: z.enum(["unknown", "basic", "experienced", "professional"]),
      evidenceType: z.enum(["explicit", "inferred", "completed_order", "behavior"]),
      confidence: z.number().min(0).max(1),
    }),
  ),
  resources: z.array(
    z.object({
      label: z.string(),
      resourceType: z.enum([
        "vehicle",
        "tool",
        "equipment",
        "property",
        "space",
        "audience",
        "digital_asset",
        "other",
      ]),
      attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
      evidenceType: z.enum(["explicit", "inferred"]),
      confidence: z.number().min(0).max(1),
    }),
  ),
});
export type CapabilityExtractionResult = z.infer<typeof capabilityExtractionResultSchema>;
