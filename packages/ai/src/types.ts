import type { CapabilityExtractionResult } from "@ustal/validation";
import type { OrderExtractionResult } from "@ustal/validation";

/**
 * Бизнес-логика api/worker зависит только от этих интерфейсов, никогда — от
 * конкретного провайдера напрямую. Реализация выбирается в
 * packages/config (AI_PROVIDER) и подключается один раз в bootstrap worker'а.
 * См. docs/architecture.md.
 */

export interface AiCallMeta {
  operationType: string;
  traceId: string;
  promptVersion: string;
  schemaVersion: string;
}

export interface AiCallResult<T> {
  data: T;
  provider: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number;
  /** Successful structured response may include bounded schema/evidence repair attempts. */
  validationAttempts?: number;
  /** A secondary verification step failed technically (verdict usable now, never memoized). */
  degraded?: boolean;
}

export interface SpeechToTextProvider {
  transcribe(
    audio: { filePath: string; mimeType: string },
    meta: AiCallMeta,
  ): Promise<AiCallResult<{ transcript: string }>>;
}

export interface StructuredExtractionProvider {
  /** profileHasUpdates: the user explicitly lifted/replaced an earlier restriction (see profile-restrictions.ts). */
  reviewSemantic(input: { profile: string[]; order: string[]; profileHasUpdates?: boolean }, meta: AiCallMeta): Promise<AiCallResult<import("@ustal/validation").SemanticReview>>;
  normalizeMatching(
    input: { kind: "profile" | "order"; professionRule?: boolean; text: string; extracted: unknown; ontology: import("@ustal/validation").OntologyOption[];
      /** Profile update by one message: the current profile items; `text` is then only the new message. */
      profileItems?: import("@ustal/validation").ProfileItemOption[] },
    meta: AiCallMeta,
  ): Promise<AiCallResult<import("@ustal/validation").SemanticResult>>;
  extractCapabilityProfile(
    input: { text: string; previousProfileSummary?: string },
    meta: AiCallMeta,
  ): Promise<AiCallResult<CapabilityExtractionResult>>;

  /**
   * Phase 1 profile_facts (SHADOW): separate per-input extraction of structured profile facts. Independent
   * of extractCapabilityProfile/normalizeMatching (frozen matching prompts are never extended).
   */
  extractProfileFacts(
    input: { text: string },
    meta: AiCallMeta,
  ): Promise<AiCallResult<import("@ustal/validation").ProfileFactsExtraction>>;

  extractOrder(
    input: { text: string },
    meta: AiCallMeta,
  ): Promise<AiCallResult<OrderExtractionResult>>;

  /** «Простые задачи» (2026-10-15): уровень доступа заказа — основание дополнительного пути показа, не вердикт подбора. */
  classifyOrderAccess(
    input: { text: string },
    meta: AiCallMeta,
  ): Promise<AiCallResult<import("@ustal/validation").OrderAccess>>;

  /** Относится ли явный отказ/ограничение исполнителя к этому заказу (тот же вопрос, что в source review). */
  checkRefusal(
    input: { refusal: string; order: string[] },
    meta: AiCallMeta,
  ): Promise<AiCallResult<{ involves: boolean; reason: string }>>;
}

export interface EmbeddingProvider {
  embed(texts: string[], meta: AiCallMeta): Promise<AiCallResult<{ vectors: number[][] }>>;
}

export type ModerationDecision = "allow" | "allow_with_warning" | "manual_review" | "reject";

export interface ModerationProvider {
  moderate(
    input: { text: string; riskLevel: number },
    meta: AiCallMeta,
  ): Promise<AiCallResult<{ decision: ModerationDecision; reason: string }>>;
}

export interface AiProviderBundle {
  stt: SpeechToTextProvider;
  extraction: StructuredExtractionProvider;
  embedding: EmbeddingProvider;
  moderation: ModerationProvider;
}
