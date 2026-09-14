import { apiClient } from "./client";

export type OrderStatus =
  | "draft"
  | "processing"
  | "processing_failed"
  | "moderation_hold"
  | "published"
  | "negotiating"
  | "closed"
  | "expired"
  | "cancelled"
  | "rejected";

export type ModerationStatus = "pending" | "allow" | "allow_with_warning" | "manual_review" | "reject";

export type ResponseStatus = "active" | "withdrawn" | "not_selected";

export type AssignmentStatus = "selected" | "completed" | "not_completed" | "cancelled";

/**
 * Пауза «Проверка транскрипции» (экран 9/11, claude/pipeline-split-design.md):
 * transcribing (voice, STT ещё не готов) -> awaiting_review (можно править) ->
 * confirmed (ушло в extraction). Text-ввод — сразу confirmed.
 */
export type SourceStatus = "transcribing" | "awaiting_review" | "confirmed";

export interface OrderRequirement {
  id: string;
  ontologyNodeId: string;
  requirementType: "required_capability" | "desired_capability" | "required_resource" | "desired_resource";
  isMandatory: boolean;
}

export interface OrderDetail {
  id: string;
  status: OrderStatus;
  cityId: string;
  normalizedTitle: string | null;
  normalizedDescription: string | null;
  priceMinor: number | null;
  currency: string;
  riskLevel: number;
  moderationStatus: ModerationStatus;
  createdAt: string;
  publishedAt: string | null;
  contextualChips: string[];
  requirements: OrderRequirement[];
  photoMediaIds: string[];
  /** Видно только автору (единственному, у кого есть доступ к GET /orders/{id}). */
  sourceStatus: SourceStatus;
  transcript: string | null;
}

export interface CreateOrderTextInput {
  inputType: "text";
  text: string;
  priceMinor?: number;
  mediaIds?: string[];
}

export interface CreateOrderVoiceInput {
  inputType: "voice";
  audioMediaId: string;
  priceMinor?: number;
  mediaIds?: string[];
}

export type CreateOrderInput = CreateOrderTextInput | CreateOrderVoiceInput;

export interface CreateOrderAccepted {
  orderId: string;
  status: "processing";
}

export interface OrderTranscriptUpdated {
  id: string;
  transcript: string | null;
  sourceText: string;
}

export interface OrderConfirmAccepted {
  orderId: string;
  status: "processing";
}

export interface PublishOrderResult {
  id: string;
  status: OrderStatus;
  publishedAt: string | null;
}

/**
 * POST /orders (docs/api.md) — запускает асинхронный extraction+moderation
 * пайплайн. Голосовой заказ сначала уходит только на STT (ORDER_TRANSCRIBE,
 * пауза «Проверка транскрипции» — экраны 9/11, claude/pipeline-split-design.md)
 * и ждёт явного подтверждения (editOrderTranscript/confirmOrderTranscript)
 * прежде чем запустится extraction; text-заказ — без паузы, сразу extraction.
 * Идемпотентно по Idempotency-Key, как /profile/inputs.
 */
export function createOrder(input: CreateOrderInput, idempotencyKey: string): Promise<CreateOrderAccepted> {
  return apiClient.request<CreateOrderAccepted>("/orders", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...input, mediaIds: input.mediaIds ?? [] }),
  });
}

export function getOrder(orderId: string): Promise<OrderDetail> {
  return apiClient.request<OrderDetail>(`/orders/${orderId}`);
}

export function retryOrder(orderId: string): Promise<void> {
  return apiClient.request(`/orders/${orderId}/retry`, { method: "POST" });
}

/**
 * Пауза «Проверка транскрипции» для голосового заказа (экраны 9/11,
 * claude/pipeline-split-design.md) — тот же паттерн, что и для профиля:
 * поллинг getOrder() до sourceStatus="awaiting_review", правка,
 * подтверждение запускает extraction.
 */
export function editOrderTranscript(orderId: string, transcriptCorrected: string): Promise<OrderTranscriptUpdated> {
  return apiClient.request<OrderTranscriptUpdated>(`/orders/${orderId}/transcript`, {
    method: "PATCH",
    body: JSON.stringify({ transcriptCorrected }),
  });
}

export function confirmOrderTranscript(orderId: string, idempotencyKey: string): Promise<OrderConfirmAccepted> {
  return apiClient.request<OrderConfirmAccepted>(`/orders/${orderId}/confirm-transcript`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: "{}",
  });
}

/** Публикация — всегда явное действие автора, никогда не триггерится автоматически. */
export function publishOrder(orderId: string): Promise<PublishOrderResult> {
  return apiClient.request<PublishOrderResult>(`/orders/${orderId}/publish`, { method: "POST", body: "{}" });
}

export function cancelOrder(orderId: string): Promise<void> {
  return apiClient.request<void>(`/orders/${orderId}/cancel`, { method: "POST", body: "{}" });
}
