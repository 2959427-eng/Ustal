/**
 * Модель AI-профиля возможностей. Расширяемая структура, а не конечный список
 * профессий — см. docs/architecture.md и мастер-ТЗ раздел 8.
 */

export type Proficiency = "unknown" | "basic" | "experienced" | "professional";
export type EvidenceType = "explicit" | "inferred" | "completed_order" | "behavior";
export type ProfileEvidenceType = "explicit" | "inferred";

export type ResourceType =
  | "vehicle"
  | "tool"
  | "equipment"
  | "property"
  | "space"
  | "audience"
  | "digital_asset"
  | "other";

export interface UserCapability {
  ontologyNodeId: string;
  label: string;
  proficiency: Proficiency;
  evidenceType: EvidenceType;
  confidence: number; // 0..1
}

export interface UserResource {
  ontologyNodeId: string;
  label: string;
  resourceType: ResourceType;
  attributes: Record<string, string | number | boolean>;
  evidenceType: ProfileEvidenceType;
  confidence: number; // 0..1
}

export type PreferenceSignal = "positive" | "negative";
export type PreferenceSource = "wants_similar" | "hide_similar" | "response" | "completed_order";

export interface LearnedPreference {
  ontologyNodeId: string;
  signal: PreferenceSignal;
  source: PreferenceSource;
  weight: number;
}

export interface CapabilityProfile {
  userId: string;
  summary: string;
  capabilities: UserCapability[];
  resources: UserResource[];
  learnedPreferences: LearnedPreference[];
  profileVersion: number;
  extractionVersion: string;
  embeddingModel: string | null;
}
