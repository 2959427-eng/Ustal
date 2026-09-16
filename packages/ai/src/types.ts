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
}

export interface SpeechToTextProvider {
  transcribe(
    audio: { filePath: string; mimeType: string },
    meta: AiCallMeta,
  ): Promise<AiCallResult<{ transcript: string }>>;
}

export interface StructuredExtractionProvider {
  reviewSemantic(input: { profile: string[]; order: string[] }, meta: AiCallMeta): Promise<AiCallResult<{ compatible: boolean; confidence: number; reason: string }>>;
  normalizeMatching(
    input: { kind: "profile" | "order"; text: string; extracted: unknown; ontology: import("@ustal/validation").OntologyOption[] },
    meta: AiCallMeta,
  ): Promise<AiCallResult<import("@ustal/validation").SemanticResult>>;
  extractCapabilityProfile(
    input: { text: string; previousProfileSummary?: string },
    meta: AiCallMeta,
  ): Promise<AiCallResult<CapabilityExtractionResult>>;

  extractOrder(
    input: { text: string },
    meta: AiCallMeta,
  ): Promise<AiCallResult<OrderExtractionResult>>;
}

export interface EmbeddingProvider {
  embed(texts: string[], meta: AiCallMeta): Promise<AiCallResult<{ vectors: number[][] }>>;
}

export type ModerationDecision = "allow" | "allow_with_warning" | "manual_review" | "reject";

export interface ModerationProvider {
  moderate(
    input: { text: string; regulated: boolean; riskLevel: number },
    meta: AiCallMeta,
  ): Promise<AiCallResult<{ decision: ModerationDecision; reason: string }>>;
}

export interface AiProviderBundle {
  stt: SpeechToTextProvider;
  extraction: StructuredExtractionProvider;
  embedding: EmbeddingProvider;
  moderation: ModerationProvider;
}
