import { z } from "zod";

export const createOrderSchema = z.object({
  inputType: z.enum(["text", "voice"]),
  text: z.string().min(1).max(4000).optional(),
  audioMediaId: z.string().uuid().optional(),
  priceMinor: z.number().int().positive().optional(),
  mediaIds: z.array(z.string().uuid()).max(10).default([]),
}).refine((v) => (v.inputType === "text" ? !!v.text : !!v.audioMediaId), {
  message: "text обязателен для inputType=text, audioMediaId — для inputType=voice",
});
export type CreateOrderRequest = z.infer<typeof createOrderSchema>;

export const orderExtractionResultSchema = z.object({
  normalizedTitle: z.string(),
  normalizedDescription: z.string(),
  actions: z.array(z.string()),
  requiredCapabilities: z.array(z.string()),
  desiredCapabilities: z.array(z.string()),
  requiredResources: z.array(z.string()),
  desiredResources: z.array(z.string()),
  physicalRequirements: z.array(z.string()).default([]),
  complexity: z.enum(["low", "medium", "high"]),
  requiresQualification: z.boolean(),
  regulated: z.boolean(),
  estimatedDurationMinutes: z.number().int().positive().nullable(),
  contextualChips: z.array(z.string()).default([]),
});
export type OrderExtractionResult = z.infer<typeof orderExtractionResultSchema>;

export const createResponseSchema = z.object({
  offeredPriceMinor: z.number().int().positive().optional(),
  comment: z.string().max(1000).optional(),
  availabilityText: z.string().max(300).optional(),
});
export type CreateResponseRequest = z.infer<typeof createResponseSchema>;

// PATCH /responses/{id} — та же форма, что и создание, но все поля
// опциональны (точечная правка одного поля не должна требовать остальные).
export const updateResponseSchema = z.object({
  offeredPriceMinor: z.number().int().positive().nullable().optional(),
  comment: z.string().max(1000).nullable().optional(),
  availabilityText: z.string().max(300).nullable().optional(),
});
export type UpdateResponseRequest = z.infer<typeof updateResponseSchema>;

export const contactUnlockSchema = z.object({
  responseId: z.string().uuid(),
});
export type ContactUnlockRequest = z.infer<typeof contactUnlockSchema>;

export const reviewSchema = z.object({
  toUserId: z.string().uuid(),
  orderId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  text: z.string().max(1000).optional(),
});
export type ReviewRequest = z.infer<typeof reviewSchema>;
