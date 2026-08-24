import { z } from "zod";

export const reportSchema = z.object({
  targetType: z.enum(["order", "user", "response"]),
  targetId: z.string().uuid(),
  reason: z.string().min(1).max(100),
  comment: z.string().max(1000).optional(),
});
export type ReportRequest = z.infer<typeof reportSchema>;

export const blockSchema = z.object({
  blockedId: z.string().uuid(),
});
export type BlockRequest = z.infer<typeof blockSchema>;
