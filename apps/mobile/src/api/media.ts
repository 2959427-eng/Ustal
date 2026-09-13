import { apiClient, getApiBaseUrl } from "./client";
import { Platform } from "react-native";

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
  file?: File;
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
export async function uploadMedia(kind: MediaKind, file: UploadableFile): Promise<MediaUploaded> {
  const form = new FormData();
  form.append("kind", kind);
  if (Platform.OS === "web") {
    let blob: Blob;
    if (file.file) {
      blob = file.file;
    } else {
      const response = await fetch(file.uri);
      if (!response.ok) throw new Error("Не удалось прочитать выбранный файл.");
      blob = await response.blob();
    }
    form.append("file", blob, file.name);
  } else {
    form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  }
  return apiClient.uploadForm<MediaUploaded>("/media", form);
}

/**
 * URL для GET /media/{id} (apps/api/src/routes/media.ts) — используется в
 * <Image source={{uri: getMediaUrl(id)}}> для аватарки профиля. Не через
 * apiClient.request — это не JSON-эндпоинт, а прямая ссылка на файл.
 */
export function getMediaUrl(mediaId: string): string {
  return `${getApiBaseUrl()}/media/${mediaId}`;
}
