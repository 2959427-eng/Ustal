/**
 * Абстракция хранилища медиа — тот же паттерн, что и packages/ai
 * (AiProviderBundle): бизнес-код зависит только от интерфейса, конкретная
 * реализация выбирается через MEDIA_STORAGE_PROVIDER без изменения кода
 * вызывающей стороны. См. docs/architecture.md, добавление #10.
 */
export type MediaKind = "photo" | "audio";

export interface StoredMedia {
  storageKey: string;
}

export interface MediaStorageProvider {
  readonly name: "local" | "s3";
  upload(input: { buffer: Buffer; ownerId: string; kind: MediaKind; mimeType: string }): Promise<StoredMedia>;
  /**
   * Абсолютный путь/URL, по которому worker/api могут прочитать файл обратно
   * (например для STT). Async (не просто string) начиная с реализации s3-
   * провайдера (Фаза 8, architecture.md §5): для local — синхронное построение
   * пути, для s3 — presigned GET URL, требующий подписи через AWS SDK
   * (криптографически синхронно, но сам SDK-клиент асинхронный по контракту).
   */
  resolvePath(storageKey: string): Promise<string>;
}
