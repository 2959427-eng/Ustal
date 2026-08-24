import { z } from "zod";

export const registerDeviceSchema = z.object({
  expoPushToken: z.string().min(1).max(300),
  platform: z.enum(["ios", "android"]),
});
export type RegisterDeviceRequest = z.infer<typeof registerDeviceSchema>;
