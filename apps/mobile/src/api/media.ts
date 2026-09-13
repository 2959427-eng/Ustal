import { apiClient, getApiBaseUrl } from "./client";

export type MediaKind = "photo" | "audio";

/**
 * Файл, выбранный `expo-image-picker`/`expo-av` (native) или `<input
 * type=file>` (web, тогда `file` — настоящий DOM `File`).
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
 *
 * 2026-09-14 fix #1: раньше на native (`Platform.OS !== "web"`) файл
 * добавлялся в `FormData` старым RN-шорткатом `{uri, name, type}` —
 * это на нашей версии RN (`0.86.3`) реально падало на телефоне с
 * `Unsupported FormData part implementation` (репродуцировано на
 * устройстве, см. AI_HANDOFF.md) до того, как запрос вообще уходил на
 * сервер — глобальный `fetch` больше не понимает этот шорткат, нужен
 * настоящий `Blob`. Убрали ветвление по платформе — везде читаем файл
 * через `fetch(file.uri)` (для `file://`/`content://`/`ph://` это
 * работает и на native, не только на web) и добавляем в форму уже
 * настоящий `Blob`, как на web раньше в fallback-ветке.
 *
 * 2026-09-14 fix #2: после fix #1 запрос стал реально доходить до
 * сервера, но тот отвечал `invalid_mime_type` («Выберите JPEG, PNG или
 * WebP») даже на настоящее JPEG-фото с камеры/галереи. Причина:
 * `fetch(file.uri)` на локальном `file://`/`content://`/`ph://` URI на
 * native не всегда сохраняет реальный mime в `Blob.type` (часто пусто
 * или generic `application/octet-stream`) — а именно `Blob.type`
 * определяет `Content-Type` этой части multipart-тела, по которому
 * сервер (`apps/api/src/routes/media.ts`, whitelist `MEDIA_LIMITS`)
 * сверяет формат. `expo-image-picker` (см. `AvatarPicker.tsx`) уже
 * заранее даёт верный mime в `file.type` — не полагаемся на то, что
 * угадает `fetch`, а пересобираем `Blob` с явным типом из `file.type`.
 */
export async function uploadMedia(kind: MediaKind, file: UploadableFile): Promise<MediaUploaded> {
  const form = new FormData();
  form.append("kind", kind);
  let blob: Blob;
  if (file.file) {
    blob = file.file;
  } else {
    const response = await fetch(file.uri);
    if (!response.ok) throw new Error("Не удалось прочитать выбранный файл.");
    const raw = await response.blob();
    blob = new Blob([raw], { type: file.type });
  }
  form.append("file", blob, file.name);
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
