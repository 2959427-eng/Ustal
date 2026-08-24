/**
 * Абстракция push-провайдера — тот же паттерн, что и packages/ai
 * (AiProviderBundle) и packages/storage (MediaStorageProvider): бизнес-код
 * (worker-обработчик notification_dispatch) зависит только от этого
 * интерфейса, конкретная реализация выбирается через PUSH_PROVIDER без
 * изменения кода вызывающей стороны. См. docs/architecture.md.
 */
export interface PushSendResult {
  ok: boolean;
  providerMessageId: string | null;
  error: string | null;
}

export interface PushProvider {
  readonly name: "expo" | "mock";
  send(input: { expoPushToken: string; title: string; body: string; data?: Record<string, unknown> }): Promise<PushSendResult>;
}
