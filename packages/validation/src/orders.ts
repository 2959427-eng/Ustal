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

export const reviewSchema = z.object({
  toUserId: z.string().uuid(),
  orderId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  text: z.string().max(1000).optional(),
});
export type ReviewRequest = z.infer<typeof reviewSchema>;
