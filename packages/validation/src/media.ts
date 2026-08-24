import { z } from "zod";

export const mediaKindSchema = z.enum(["photo", "audio"]);

export const MEDIA_LIMITS = {
  photo: { maxBytes: 10 * 1024 * 1024, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
  audio: { maxBytes: 15 * 1024 * 1024, mimeTypes: ["audio/m4a", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"] },
} as const;
