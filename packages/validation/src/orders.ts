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

// JSON Schema, которую обязана вернуть ModerationProvider для AI-модерации
// пограничных случаев (packages/ai/src/providers/openai.ts) — тот же контракт,
// что и ModerationDecision в packages/ai/src/types.ts (держать значения enum
// синхронными вручную: у @ustal/ai нет зависимости на @ustal/validation в
// обратную сторону, а этот enum и так уже мал и стабилен).
export const moderationDecisionSchema = z.object({
  decision: z.enum(["allow", "allow_with_warning", "manual_review", "reject"]),
  reason: z.string(),
});
export type ModerationDecisionResult = z.infer<typeof moderationDecisionSchema>;

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

export const createAssignmentSchema = z.object({
  responseId: z.string().uuid(),
});
export type CreateAssignmentRequest = z.infer<typeof createAssignmentSchema>;

export const notCompletedSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type NotCompletedRequest = z.infer<typeof notCompletedSchema>;

export const reviewSchema = z.object({
  toUserId: z.string().uuid(),
  orderId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  text: z.string().max(1000).optional(),
});
export type ReviewRequest = z.infer<typeof reviewSchema>;

// PATCH /reviews/{id} — правка своего отзыва: rating обязателен (отзыв без
// оценки бессмыслен), orderId/toUserId неизменны после создания (иначе это
// уже другой отзыв — пара from/to зафиксирована на INSERT).
export const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().max(1000).nullable().optional(),
});
export type UpdateReviewRequest = z.infer<typeof updateReviewSchema>;
