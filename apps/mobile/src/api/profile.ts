import { apiClient } from "./client";

export interface ProfileCapability {
  id: string;
  label: string;
  proficiency: "unknown" | "basic" | "experienced" | "professional";
  evidenceType: "explicit" | "inferred" | "completed_order" | "behavior";
  confidence: number;
}

export interface ProfileResource {
  id: string;
  label: string;
  resourceType: string;
  attributes: Record<string, string | number | boolean>;
  evidenceType: "explicit" | "inferred";
  confidence: number;
}

export interface ProfileSummary {
  id: string;
  summary: string;
  profileVersion: number;
  extractionVersion: string;
  createdAt: string;
}

export interface ProfileResponse {
  profile: ProfileSummary | null;
  capabilities: ProfileCapability[];
  resources: ProfileResource[];
}

/** GET /profile — текущий применённый (status='applied') AI-профиль возможностей (раздел 7 ТЗ). */
export function getProfile(): Promise<ProfileResponse> {
  return apiClient.request<ProfileResponse>("/profile");
}

export interface SubmitProfileInputResult {
  sourceInputId: string;
  /** "transcribing" — voice, ещё нужно пройти паузу «Проверка транскрипции» (см. ниже). */
  status: "processing" | "transcribing";
}

/**
 * POST /profile/inputs (docs/api.md). Voice-ввод сначала уходит только на
 * STT (PROFILE_TRANSCRIBE, пауза «Проверка транскрипции» — экран 9,
 * claude/pipeline-split-design.md) и ждёт явного подтверждения
 * (editProfileTranscript/confirmProfileInput) прежде чем запустится
 * extraction; text-ввод — без паузы, сразу extraction (правка уже
 * произошла в композере до отправки). Идемпотентно по Idempotency-Key
 * (docs/architecture.md §5 п.10): повтор с тем же ключом и тем же телом
 * возвращает тот же ответ, не ставит вторую job в очередь.
 */
export function submitProfileInput(
  payload: { inputType: "text"; text: string } | { inputType: "voice"; audioMediaId: string },
  idempotencyKey: string,
): Promise<SubmitProfileInputResult> {
  return apiClient.request<SubmitProfileInputResult>("/profile/inputs", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
  });
}

/**
 * Пауза «Проверка транскрипции» (экран 9, claude/pipeline-split-design.md):
 * transcribing (voice, STT ещё не готов) -> awaiting_review (можно
 * поправить) -> confirmed (ушло в extraction).
 */
export type ProfileInputStatus = "transcribing" | "awaiting_review" | "confirmed";

export interface ProfileSourceInput {
  id: string;
  inputType: "text" | "voice";
  status: ProfileInputStatus;
  transcript: string | null;
  transcriptCorrected: string | null;
  createdAt: string;
}

export interface ProfileTranscriptUpdated {
  id: string;
  transcript: string | null;
  transcriptCorrected: string | null;
}

/**
 * Клиент поллит это после voice-submit (status="transcribing") до
 * awaiting_review, затем может поправить (editProfileTranscript) и
 * подтвердить (confirmProfileInput).
 */
export function getProfileInput(sourceInputId: string): Promise<ProfileSourceInput> {
  return apiClient.request<ProfileSourceInput>(`/profile/inputs/${sourceInputId}`);
}

export function editProfileTranscript(sourceInputId: string, transcriptCorrected: string): Promise<ProfileTranscriptUpdated> {
  return apiClient.request<ProfileTranscriptUpdated>(`/profile/inputs/${sourceInputId}`, {
    method: "PATCH",
    body: JSON.stringify({ transcriptCorrected }),
  });
}

export function confirmProfileInput(sourceInputId: string, idempotencyKey: string): Promise<SubmitProfileInputResult> {
  return apiClient.request<SubmitProfileInputResult>(`/profile/inputs/${sourceInputId}/confirm`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: "{}",
  });
}

/**
 * Пауза «Подтверждение изменений» (экран 10, claude/pipeline-split-design.md):
 * extraction создаёт draft-версию профиля вместо немедленно «текущей».
 * `diff` — что изменится относительно текущего applied-профиля, посчитано
 * на сервере (GET /profile/draft), чтобы решение «применить/отклонить»
 * принималось ДО применения, а не постфактум.
 */
export interface ProfileDraft {
  id: string;
  summary: string;
  profileVersion: number;
  createdAt: string;
}

export interface ProfileDraftDiff {
  addedCapabilities: string[];
  removedCapabilities: string[];
  addedResources: string[];
  removedResources: string[];
}

export interface ProfileDraftApplied {
  profileId: string;
  status: "applied";
}

// Сервер отдаёт только {draft: null}, когда черновика нет — остальные поля
// в ответе отсутствуют, а не пустые массивы/объект (см. apps/api/src/routes/profile.ts).
export type ProfileDraftResponse =
  | { draft: null }
  | { draft: ProfileDraft; capabilities: ProfileCapability[]; resources: ProfileResource[]; diff: ProfileDraftDiff };

/**
 * Клиент поллит это после confirmProfileInput (voice) или сразу после
 * submitProfileInput (text) до появления черновика, показывает diff, затем
 * applyProfileDraft или discardProfileDraft.
 */
export function getProfileDraft(): Promise<ProfileDraftResponse> {
  return apiClient.request<ProfileDraftResponse>("/profile/draft");
}

export function applyProfileDraft(draftId: string): Promise<ProfileDraftApplied> {
  return apiClient.request<ProfileDraftApplied>(`/profile/draft/${draftId}/apply`, { method: "POST", body: "{}" });
}

export function discardProfileDraft(draftId: string): Promise<void> {
  return apiClient.request<void>(`/profile/draft/${draftId}/discard`, { method: "POST", body: "{}" });
}

export interface UpdateProfileInput {
  name?: string;
  cityId?: string;
  whatsappPhone?: string | null;
}

export interface UpdateProfileResult {
  name: string;
  cityId: string;
  whatsappPhone: string | null;
}

/** PATCH /profile (раздел 27 ТЗ, экран настроек) — точечные правки без AI: имя, город, WhatsApp. */
export function updateProfile(input: UpdateProfileInput): Promise<UpdateProfileResult> {
  return apiClient.request<UpdateProfileResult>("/profile", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export type PreferenceSignal = "positive" | "negative";

export interface LearnedPreference {
  id: string;
  ontologyNodeId: string;
  ontologyNodeName: string | null;
  signal: PreferenceSignal;
  source: string;
  weight: string;
  createdAt: string;
}

/** GET /profile/preferences (раздел 27 ТЗ) — чему AI научился на основе поведения (например, «не показывать подобное»). */
export function getPreferences(): Promise<LearnedPreference[]> {
  return apiClient.request<LearnedPreference[]>("/profile/preferences");
}

/** DELETE /profile/preferences/{id} — отмена конкретного «научился» (мягкое удаление, revokedAt на сервере). */
export function revokePreference(id: string): Promise<void> {
  return apiClient.request<void>(`/profile/preferences/${id}`, { method: "DELETE" });
}
