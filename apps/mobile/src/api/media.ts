import { apiClient } from "./client";

export type MediaKind = "photo" | "audio";

/**
 * React Native (Expo) описывает файл для multipart/form-data объектом
 * `{uri, name, type}`, а не `Blob`/`File` из DOM — так его понимает
 * RN-полифилл `FormData`, поэтому тип не совпадает со стандартным
 * `FormDataEntryValue`.
 */
export interface UploadableFile {
  uri: string;
  name: string;
  type: string;
}

export interface MediaUploaded {
  mediaId: string;
}

/**
 * POST /media (apps/api/src/routes/media.ts) — общая точка загрузки для
 * голоса (`kind: "audio"`) и фото (`kind: "photo"`), используется и
 * профилем, и заказами. Multipart, поэтому идёт через отдельный
 * `apiClient.uploadForm` (не `request<T>`, который всегда шлёт
 * `Content-Type: application/json`) — boundary должен выставить сам
 * `fetch`/полифилл `FormData` по телу запроса.
 */
export function uploadMedia(kind: MediaKind, file: UploadableFile): Promise<MediaUploaded> {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", file as unknown as Blob);
  return apiClient.uploadForm<MediaUploaded>("/media", form);
}
