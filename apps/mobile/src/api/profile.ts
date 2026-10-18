import { apiClient } from "./client";
// Subpath-экспорт пакета (packages/domain/package.json "exports"): Metro не загружает index.ts пакета, чьи
// реэкспорты "./x.js" (NodeNext для сервера) он не разрешает. Та же функция, что на сервере (identity №8).
import { normalizeProfileItemIdentity } from "@ustal/domain/profile-item-identity";

export interface ProfileCapability {
  id: string;
  label: string;
  proficiency: "unknown" | "basic" | "experienced" | "professional";
  evidenceType: "explicit" | "inferred" | "completed_order" | "behavior";
  confidence: number;
}

/** Характеристика ресурса (2026-10-15): «6 мест», «1,5 т», «Sony». Только показ. */
export interface ItemAttribute {
  key: string;
  value: string | number;
  unit: string | null;
}

export interface ProfileResource {
  id: string;
  label: string;
  resourceType: string;
  attributes: Record<string, string | number | boolean>;
  /** Необязательно — старый API их не отдавал. */
  itemAttributes?: ItemAttribute[];
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

/** Фраза, распознанная AI, но не сопоставленная с онтологией (matching использует её через embedding). */
export interface UnmappedFact {
  /** id факта текущей версии (2026-10-17) — для «Убрать». Необязательно — старый API его не отдавал. */
  id?: string;
  kind: "capability" | "resource";
  phrase: string;
  itemAttributes?: ItemAttribute[];
}

export interface ProfileResponse {
  profile: ProfileSummary | null;
  capabilities: ProfileCapability[];
  resources: ProfileResource[];
  /** Необязательно — старый API его не отдавал. */
  unmapped?: UnmappedFact[];
  /** Явные ограничения пользователя (дословно его словами). Необязательно — старый API их не отдавал. */
  restrictions?: ProfileRestriction[];
  /** Убранные кнопкой пункты (2026-10-17) — для «Восстановить». Необязательно — старый API их не отдавал. */
  removed?: RemovedProfileItem[];
}

export type ProfileItemKind = "capability" | "resource" | "restriction";
export type ProfileItemAction = "revoke" | "restore";
/** Пункт, убранный кнопкой «Убрать» / «Снять ограничение» (GET /profile → removed). */
export interface RemovedProfileItem {
  id: string;
  kind: ProfileItemKind;
  label: string;
  decidedAt: string | null;
}
export interface ProfileItemActionResult {
  status: "revoked" | "restored";
  changed: boolean;
  profileVersion: number;
}

/**
 * Прямое действие с пунктом профиля без AI (2026-10-17): POST /profile/items/:kind/:id/:action.
 * Не тратит лимит AI-сообщений. id — пункт ТЕКУЩЕЙ версии: после успеха профиль нужно перечитать
 * (версия и id пунктов меняются).
 */
export function profileItemAction(kind: ProfileItemKind, id: string, action: ProfileItemAction): Promise<ProfileItemActionResult> {
  return apiClient.request<ProfileItemActionResult>(`/profile/items/${kind}/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    body: "{}",
  });
}

export type RestrictionType = "time" | "work" | "scope";
export interface ProfileRestriction {
  type: RestrictionType;
  text: string;
  /** id факта текущей версии (2026-10-17) — для «Снять ограничение». Необязательно — старый API его не отдавал. */
  id?: string;
}
const RESTRICTION_ORDER: RestrictionType[] = ["time", "work", "scope"];
export const RESTRICTION_LABELS: Record<RestrictionType, string> = {
  time: "Время",
  work: "Виды работ",
  scope: "Только",
};

/** Ограничения для раздела «Ограничения»: группы в постоянном порядке, пустые группы не возвращаются. */
export function restrictionGroups(p: Pick<ProfileResponse, "restrictions"> | undefined): { type: RestrictionType; label: string; items: string[] }[] {
  const all = p?.restrictions ?? [];
  return RESTRICTION_ORDER.map((type) => ({
    type,
    label: RESTRICTION_LABELS[type],
    items: [...new Set(all.filter((r) => r.type === type).map((r) => r.text.trim()).filter(Boolean))],
  })).filter((g) => g.items.length > 0);
}

/**
 * Один пункт — одна строка (mobile QA 2026-10-14, M08): «самолёт» из онтологии и «Самолет.» среди
 * нераспознанных — один ресурс. Сравнение — общей identity сервера (normalizeProfileItemIdentity:
 * регистр, ё/е, пробелы, конечная пунктуация); показывается первая подпись (сопоставленная онтологией).
 */
function uniqueByIdentity(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = normalizeProfileItemIdentity(label);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const UNIT_LABELS: Record<string, string> = { t: "т", kg: "кг", m: "м", pcs: "шт" };
function seatsWord(n: number) {
  const d = Math.abs(n) % 100, u = d % 10;
  if (!Number.isInteger(n)) return "места";
  if (d >= 11 && d <= 14) return "мест";
  return u === 1 ? "место" : u >= 2 && u <= 4 ? "места" : "мест";
}
/** «6 мест», «1,5 т», «5 м», «Sony». */
export function formatItemAttribute(a: ItemAttribute): string {
  if (typeof a.value !== "number") return String(a.value);
  const n = String(a.value).replace(".", ",");
  if (a.key === "passenger_capacity") return `${n} ${seatsWord(a.value)}`;
  const unit = a.unit ? (UNIT_LABELS[a.unit] ?? a.unit) : "";
  return unit ? `${n} ${unit}` : n;
}
/** Подпись ресурса с характеристиками: «Автобус · 6 мест». */
export function resourceLabel(label: string, attributes: ItemAttribute[] | undefined): string {
  const parts = (attributes ?? []).map(formatItemAttribute).filter(Boolean);
  return [label, ...parts].join(" · ");
}

/** Все распознанные навыки/ресурсы для показа: сопоставленные с онтологией + нераспознанные онтологией фразы. */
export function recognizedLabels(p: Pick<ProfileResponse, "capabilities" | "resources" | "unmapped"> | undefined): {
  capabilities: string[];
  resources: string[];
} {
  const capabilities = (p?.capabilities ?? []).map((c) => c.label);
  const resources = (p?.resources ?? []).map((r) => resourceLabel(r.label, r.itemAttributes));
  for (const f of p?.unmapped ?? []) f.kind === "resource" ? resources.push(resourceLabel(f.phrase, f.itemAttributes)) : capabilities.push(f.phrase);
  return { capabilities: uniqueByIdentity(capabilities), resources: uniqueByIdentity(resources) };
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
  /** Новые фразы без ontology-узла; необязательно — старый API его не отдавал. */
  addedUnmapped?: string[];
}

export interface ProfileDraftApplied {
  profileId: string;
  status: "applied";
}

// Сервер отдаёт только {draft: null}, когда черновика нет — остальные поля
// в ответе отсутствуют, а не пустые массивы/объект (см. apps/api/src/routes/profile.ts).
export type ProfileDraftResponse = (
  | { draft: null }
  | { draft: ProfileDraft; capabilities: ProfileCapability[]; resources: ProfileResource[]; unmapped?: UnmappedFact[]; diff: ProfileDraftDiff }
) & ProfileProcessingState;

/**
 * Сервер: сохранённое сообщение ещё обрабатывается (mobile QA 2026-10-14, M11). В отличие от локальной
 * отметки «текст отправлен», переживает перезапуск приложения. Старый API этих полей не отдавал.
 */
export interface ProfileProcessingState {
  processing?: boolean;
  /** Когда отправлено самое раннее ещё не обработанное сообщение (ISO). */
  processingSince?: string | null;
}

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
  /** mediaId из uploadMedia("photo", ...) (src/api/media.ts) — см. AvatarPicker.tsx. */
  avatarMediaId?: string | null;
  /** «О себе»; null или пустая строка очищают. */
  about?: string | null;
}

export interface UpdateProfileResult {
  name: string;
  cityId: string;
  whatsappPhone: string | null;
  avatarMediaId: string | null;
  about: string | null;
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
