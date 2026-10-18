import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getDb, PROFILE_SOURCE_SEPARATOR, schema, type Database } from "@ustal/database";
import { semanticResultSchema, type ProfileItemOption, type SemanticFact } from "@ustal/validation";
import { recordOntologyCandidates } from "@ustal/ontology";
import { isTimeLimited } from "@ustal/matching";
import { areaOf, isLift, resolveRestrictionUpdates, SUPERSEDED_KIND, toLiftMarker, toSupersededMarker } from "./profile-restrictions.js";
import { applyDecision, type ScheduledDecision } from "./profile-decisions.js";
import { factRelatesToItem, hasStaleEffectiveText, isUserRemovedMarker, itemKey, liftedMarkerSignature, userRemovedFamily } from "@ustal/matching";
import { namedIn } from "./profile-update-guard.js";
import { dropCareerContext, isRevokedCapability, isUserAssetResource, narrowRefusalNodeIds, inheritRevokes, resolveProfileNegatives, scopeRefusalsOfPriorSkills, type MessageOrder } from "./profile-negatives.js";
import { deduplicateProfileResourceFacts } from "./profile-resource-identity.js";
import { guardProfileUpdate, mentionsTime } from "./profile-update-guard.js";
import { retainedExplicitCapabilities } from "./profile-capability-fallback.js";
import { normalizeAttributes, normalizeLabel } from "./profile-item-attributes.js";
import { normalizeProfileItemIdentity } from "@ustal/domain";

// v3.1 (2026-10-17): дни недели из нормализации — явный знак daysMode, сервер приводит к разрешённым дням. Документы
// прежней версии (возможна инверсия «не работаю по …») распознаются по processingVersion для переобработки.
export const PIPELINE_VERSION = "semantic-v3.1";
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export interface PreparedFact extends SemanticFact {
  nodeIds: string[];
  embedding: number[];
}
export interface PreparedDocument {
  processingVersion: string;
  sourceHash: string;
  sourceText: string;
  embeddingModel: string;
  embedding: number[];
  facts: PreparedFact[];
  /** Факты, извлечённые из обработанного текста (при обновлении — только из нового сообщения). */
  addedFacts?: PreparedFact[];
  /** Операции модели, отклонённые сервером при обновлении по одному сообщению (диагностика). */
  rejectedOperations?: { op: string; reason: string }[];
}

/**
 * Обновление профиля по одному сообщению (2026-10-13). Прежде каждое «Сохранить» заново разбирало всю
 * историю сообщений, и на длинной истории модель «пересобирала» профиль по-разному: всплывали отозванные
 * навыки и убранные ресурсы, пропадали ограничения. Теперь состояние применённого профиля (его факты с узлами
 * и embedding) берётся как есть, модель видит только новое сообщение и текущий профиль (CURRENT_PROFILE) и
 * возвращает новые факты и removes — какие пункты сообщение отменяет. Сервер применяет это и проверяет
 * результат прежними детерминированными правилами по порядку «прежнее состояние → новое сообщение».
 * Первое сообщение профиля (и заказы) обрабатывается как раньше.
 */
export interface PriorProfileState {
  /** Накопительный текст прежних сообщений (история, source review). */
  sourceText: string;
  /** Факты применённого профиля, включая историю (kind="superseded"). */
  facts: PreparedFact[];
}

type FactRow = typeof schema.matchingFacts.$inferSelect;
/** Факты документа профиля из БД → состояние профиля для обновления по одному сообщению. */
export function priorFactsFromRows(rows: FactRow[]): PreparedFact[] {
  return rows.map((r) => ({
    kind: r.kind as PreparedFact["kind"],
    constraintType: r.constraintType as PreparedFact["constraintType"],
    constraintScope: r.constraintScope as PreparedFact["constraintScope"],
    resourceRole: r.resourceRole as PreparedFact["resourceRole"],
    resourceCapacity: r.resourceCapacity,
    phrase: r.phrase,
    label: r.label ?? null,
    attributes: (r.attributes ?? []) as PreparedFact["attributes"],
    evidence: r.evidence,
    canonicalKeys: [],
    confidence: Number(r.confidence),
    mandatory: r.mandatory,
    startHour: r.startHour,
    endHour: r.endHour,
    daysOfWeek: r.daysOfWeek ?? null,
    nodeIds: (r.nodeIds ?? []) as string[],
    embedding: (r.embedding ?? []) as number[],
  }));
}

const hoursText = (f: { startHour?: number | null; endHour?: number | null; daysOfWeek?: number[] | null }) =>
  [f.startHour != null ? `с ${f.startHour}:00` : "", f.endHour != null ? `до ${f.endHour}:00` : "",
    f.daysOfWeek?.length ? `дни ${f.daysOfWeek.join(",")} (0=пн)` : ""].filter(Boolean).join(" ");
/** Действующие пункты профиля для модели (CURRENT_PROFILE) с идентификаторами item_N. */
export function profileItemsOf(facts: PreparedFact[]): { items: ProfileItemOption[]; byId: Map<string, PreparedFact> } {
  const items: ProfileItemOption[] = [];
  const byId = new Map<string, PreparedFact>();
  for (const f of facts) {
    if ((f.kind as string) === SUPERSEDED_KIND) continue;
    let type: ProfileItemOption["type"] | null;
    if (f.kind === "exclude" || f.constraintType === "exclusion") type = isRevokedCapability(f) ? "removed_skill" : "refusal";
    else if (f.kind === "availability") type = "time_limit";
    else if (f.constraintType === "scope") type = "only_scope";
    else if (f.kind === "capability") type = "skill";
    else if (f.kind === "resource") type = f.resourceRole === "missing" ? "no_resource" : isUserAssetResource(f) ? "resource" : null;
    else type = null;
    if (!type) continue;
    const id = `item_${items.length + 1}`;
    const hours = hoursText(f);
    items.push({ id, type, phrase: f.phrase, ...(f.label ? { label: f.label } : {}),
      ...(f.attributes?.length ? { attributes: f.attributes } : {}), ...(hours ? { hours } : {}) });
    byId.set(id, f);
  }
  return { items, byId };
}
const PRIOR_ORDER: MessageOrder = { seg: 0, pos: -1 };
const NEW_MESSAGE_POS = 1_000_000_000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export { mentionsTime } from "./profile-update-guard.js";

export async function prepareDocument(
  kind: "profile" | "order",
  text: string,
  extracted: unknown,
  traceId: string,
  prior?: PriorProfileState,
): Promise<PreparedDocument> {
  // Обновление по одному сообщению: text — только новое сообщение, prior — состояние применённого профиля.
  const update = kind === "profile" && prior ? profileItemsOf(prior.facts) : null;
  const fullText = kind === "profile" && prior ? [prior.sourceText, text].filter(Boolean).join(PROFILE_SOURCE_SEPARATOR) : text;
  const db = getDb();
  const ai = getAiProviders();
  const nodes = await db
    .select()
    .from(schema.ontologyNodes)
    .where(eq(schema.ontologyNodes.status, "active"));
  const synonyms = await db.select().from(schema.ontologySynonyms);
  const byKey = new Map(nodes.map((n) => [n.canonicalKey, n]));
  const byPhrase = new Map(
    nodes.flatMap(
      (n) =>
        [
          [n.nameRu.toLowerCase(), n],
          [n.canonicalKey.toLowerCase(), n],
        ] as const,
    ),
  );
  for (const s of synonyms) {
    const node = nodes.find((n) => n.id === s.ontologyNodeId);
    if (node) byPhrase.set(s.phraseRu.trim().toLowerCase(), node);
  }
  // Hash the entire catalogue, not a timestamp: ontology edits invalidate derived documents.
  const ontologyVersion = hash(
    JSON.stringify(nodes.sort((a, b) => a.id.localeCompare(b.id))) +
      JSON.stringify(synonyms.sort((a, b) => a.id.localeCompare(b.id))),
  ).slice(0, 16);
  const meta = {
    operationType: "matching_normalization",
    traceId,
    promptVersion: PIPELINE_VERSION,
    schemaVersion: "v2",
  };
  const started = new Date();
  const normalized = await ai.extraction.normalizeMatching(
    {
      kind,
      text,
      // При обновлении модель видит только новое сообщение и текущий профиль: черновое извлечение строится
      // с прежним summary и перечисляет старые пункты — модель повторяла бы их.
      extracted: update?.items.length ? {} : extracted,
      ontology: nodes
        .slice(0, 512)
        .map((n) => ({
          canonicalKey: n.canonicalKey,
          name: n.nameRu,
          nodeType: n.nodeType,
          description: n.description,
          synonyms: synonyms.filter((s) => s.ontologyNodeId === n.id).map((s) => s.phraseRu),
        })),
      ...(update?.items.length ? { profileItems: update.items } : {}),
    },
    meta,
  );
  await db
    .insert(schema.aiRuns)
    .values(buildAiRunRecord(meta, started, { result: normalized }));
  const parsed = semanticResultSchema.parse(normalized.data);
  // Подпись и характеристики пункта — только в профиле (2026-10-15); заказ их не получает.
  for (const f of parsed.facts) {
    if (kind === "profile") {
      f.label = normalizeLabel(f.label);
      f.attributes = normalizeAttributes(f.attributes);
    } else { delete f.label; delete f.attributes; }
    if (!update?.items.length) delete f.itemRef;
  }
  if (parsed.facts.some((f) => !text.includes(f.evidence)))
    throw new Error(
      "Semantic normalization returned unsupported source evidence",
    );

  // Career context (the person's own job search: desired position/salary, openness to offers,
  // relocation or business-trip readiness) is never a constraint on service work: a refusal/scope/
  // availability fact typed as career context is dropped, so "не готов к переезду в другой город"
  // cannot reject moving orders or strip the moving skill node (recall-first). Positive facts stay.
  const candidates = dropCareerContext(kind, parsed.facts);
  const resolved = candidates.map((raw) => {
    const nonAsset = (raw.subjectType === "software_skill" || raw.subjectType === "qualification") &&
      raw.kind !== "exclude" && raw.constraintType !== "exclusion";
    // Предмет, который модель вернула навыком («самолет»: kind=capability, но subjectType=physical_resource или
    // resourceRole=available/missing — роль бывает только у ресурса), в профиле — ресурс (2026-10-13). Если узлы
    // у него — действия/навыки и это не физический предмет, правило ниже вернёт его в capability.
    // Характеристики (места, грузоподъёмность, марка) модель даёт только предмету (2026-10-15): «навык» с ними — предмет.
    const assetAsSkill = kind === "profile" && raw.kind === "capability" && raw.constraintType === "none" &&
      (raw.subjectType === "physical_resource" || raw.resourceRole === "available" || raw.resourceRole === "missing" ||
        (!!raw.attributes?.length && raw.subjectType !== "software_skill" && raw.subjectType !== "qualification"));
    const f = nonAsset ? { ...raw, kind: "capability" as const, resourceRole: "none" as const,
      mandatory: false, resourceCapacity: { value: null, unit: null, kind: null } }
      : assetAsSkill ? { ...raw, kind: "resource" as const, resourceRole: raw.resourceRole === "missing" ? "missing" as const : "available" as const } : raw;
    const exact = byPhrase.get(f.phrase.trim().toLowerCase());
    const selected = new Map<string, (typeof nodes)[number]>();
    if (exact && f.confidence >= 0.8) selected.set(exact.id, exact);
    if (f.confidence >= 0.8)
      for (const key of f.canonicalKeys) {
        const n = byKey.get(key);
        if (n) selected.set(n.id, n);
      }
    const selectedNodes = [...selected.values()];
    let factKind = f.kind;
    // A physical asset stays a resource whatever node the model picked: an action/capability node
    // for it (plane -> "вождение", coffee machine -> "готовка") is dropped below as incompatible,
    // the fact itself is kept as a resource without a node (2026-10-05, «есть самолёт» shown as a skill).
    const physicalAsset = f.kind === "resource" && f.subjectType === "physical_resource";
    if (
      f.kind === "resource" &&
      !physicalAsset &&
      f.resourceRole !== "compatibility" &&
      selectedNodes.length &&
      selectedNodes.every((n) => ["action", "capability"].includes(n.nodeType))
    )
      factKind = "capability";
    // Действие, которое модель привязала только к узлу-ресурсу («сверлить бетон» → «перфоратор»), в профиле остаётся
    // навыком без этого узла (2026-10-15): умение не превращается в имеющийся ресурс. Физический предмет,
    // возвращённый навыком, обработан выше (assetAsSkill).
    if (
      f.kind === "capability" && !nonAsset &&
      selectedNodes.length &&
      selectedNodes.every((n) => n.nodeType === "resource") &&
      !(kind === "profile" && f.subjectType !== "physical_resource")
    )
      factKind = "resource";
    const compatible = selectedNodes.filter((n) =>
      factKind === "resource"
        ? n.nodeType === "resource"
        : factKind === "capability"
          ? n.nodeType !== "resource" &&
            n.nodeType !== "object" &&
            n.nodeType !== "condition"
          : true,
    );
    return { ...f, kind: factKind, nodeIds: compatible.map((n) => n.id) };
  });
  if (kind === "profile") {
    // Часы и дни у факта профиля — только если время названо в его же сообщении (evidence — span одного
    // сообщения). На длинной истории модель переносит общее «Работаю до 21:00» на другие факты, и «Не хочу
    // больше копать» превращалось в «копать — до 21:00»: ограничение времени вместо отзыва навыка (2026-10-13).
    // Окно времени без основания не создаётся (QA 2026-10-14, №5): прежде часы обнулялись, а сам факт
    // оставался — UI показывал «Работаю до 21:00», а matching такое окно не применял. При обновлении по
    // одному сообщению время проверяет guardProfileUpdate по всему новому сообщению (с числами часов).
    if (!update?.items.length)
      for (let i = resolved.length - 1; i >= 0; i--) {
        const f = resolved[i]!;
        if (!(f.startHour != null || f.endHour != null || f.daysOfWeek?.length) || mentionsTime(f.evidence)) continue;
        if (f.kind === "availability" || f.constraintType === "availability") { resolved.splice(i, 1); continue; }
        f.startHour = null;
        f.endHour = null;
        f.daysOfWeek = null;
      }
    // A time-bounded refusal of an activity («не занимаюсь доставкой после 22:00») is a time limit
    // for that activity only: never a refusal of it at every hour, never a limit on other work.
    for (const f of resolved)
      if ((f.kind === "exclude" || f.constraintType === "exclusion") && isTimeLimited(f)) {
        f.kind = "availability";
        f.constraintType = "availability";
        f.constraintScope = "fact";
      } else if (isLift(f) && f.kind === "resource") {
        // «Купил генератор снова» модель иногда помечает как снятие ограничения; снятие бывает только у
        // ограничений, а вернувшийся ресурс — обычный имеющийся ресурс (новее «продал» — тот снимется).
        f.constraintType = "none";
        if (f.resourceRole === "none" || f.resourceRole === "missing") f.resourceRole = "available";
      } else if (f.constraintType === "exclusion" && f.kind === "capability") {
        // Отказ («не хочу больше копать») — не навык: модель иногда возвращает его как kind=capability
        // с constraintType=exclusion, и тогда он давал покрытие узла в matching и попадал в
        // положительный retrieval-текст. В профиле отказ всегда kind=exclude (2026-10-06).
        f.kind = "exclude";
      }
    // Модель иногда ставит refusalIntent на сам навык («могу копать», revoke/restriction) вместо отдельного
    // факта отказа. Это её явное суждение о навыке: revoke — навык превращается в отказ (отзыв навыка);
    // restriction — навык остаётся, рядом добавляется отказ от таких заказов (2026-10-06).
    for (const f of [...resolved])
      if (f.kind === "capability" && f.constraintType === "none" && f.refusalIntent) {
        const refusal = { ...f, kind: "exclude" as const, constraintType: "exclusion" as const, constraintScope: "whole_task" as const };
        if (f.refusalIntent === "revoke") Object.assign(f, refusal);
        else {
          f.refusalIntent = null;
          resolved.push({ ...refusal, refusalIntent: "restriction" });
        }
      }
    // Отказ от узкой деятельности не привязываем к широкому навыку (см. narrowRefusalNodeIds).
    const hasChildren = new Set(nodes.map((n) => n.parentId).filter((id): id is string => !!id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const f of resolved) {
      // A time limit keeps the activity node the model chose: dropping it would leave the limit
      // without a domain (so it could not apply to that very activity); narrowness of the limit
      // itself is already part of the mapping rules for refusals and time limits.
      if (f.kind !== "exclude" && f.constraintType !== "exclusion") continue;
      f.nodeIds = narrowRefusalNodeIds(byPhrase.get(f.phrase.trim().toLowerCase())?.id, f.nodeIds, (id) => {
        const n = byId.get(id);
        return n && { nodeType: n.nodeType, hasChildren: hasChildren.has(id) };
      });
    }
  }
  // Known extracted actions cannot disappear because another model omitted them. This is
  // ontology lookup, not keyword parsing of source text; negative facts always win below.
  const data = extracted as {
    actions?: string[];
    capabilities?: { label: string }[];
  };
  const phrases = kind === "order" ? (data.actions ?? []) : [];
  for (const phrase of phrases) {
    const n = byPhrase.get(phrase.trim().toLowerCase());
    if (!n || !["action", "capability"].includes(n.nodeType)) continue;
    if (
      resolved.some(
        (f) =>
          f.nodeIds.includes(n.id) &&
          (f.kind === "capability" || f.kind === "exclude"),
      )
    )
      continue;
    resolved.push({
      kind: "capability",
      constraintType: "none",
      constraintScope: "fact",
      resourceRole: "none",
      resourceCapacity: { value: null, unit: null, kind: null },
      phrase,
      evidence: text,
      canonicalKeys: [n.canonicalKey],
      nodeIds: [n.id],
      confidence: 0.8,
      mandatory: false,
      startHour: null,
      endHour: null,
      daysOfWeek: null,
    });
  }
  // Defensive bridge for providers/older contracts that attach a physical limit to an
  // action. Preserve that limit as a resource compatibility check without inventing ownership.
  if (kind === "order") {
    for (const fact of [...resolved]) {
      if (fact.kind !== "capability" || fact.constraintScope === "optional_component") continue;
      const capacity = fact.resourceCapacity;
      if (capacity.value == null && !capacity.unit && !capacity.kind) continue;
      if (resolved.some(f => f.resourceRole === "compatibility" && f.evidence === fact.evidence)) continue;
      resolved.push({ ...fact, kind: "resource", nodeIds: [], canonicalKeys: [], resourceRole: "compatibility", mandatory: false });
    }
  }
  // «Снятие» ограничения (constraintType="lift") бывает только в профиле; в заказе — игнорируем.
  if (kind === "order") for (let i = resolved.length - 1; i >= 0; i--) if (isLift(resolved[i]!)) resolved.splice(i, 1);
  // Отказ снимает узел с навыка только если он не старше навыка: в накопительном профиле более
  // позднее «теперь занимаюсь доставкой» не должно терять узел из-за прежнего отказа (тот снимет
  // resolveProfileNegatives). В заказе текст один — порядок не важен.
  const at = (f: { evidence: string }) => (kind === "profile" ? text.lastIndexOf(f.evidence) : 0);
  // В профиле отказ и навык сопоставляет resolveProfileNegatives (по порядку сообщений и refusalIntent):
  // отзыв навыка убирает навык, ограничение («умею, но пока не беру») навык не трогает (2026-10-06).
  const refusals = kind === "order" ? resolved.filter((f) => f.kind === "exclude") : [];
  const facts = resolved
    .map((f) =>
      f.kind === "capability"
        ? { ...f, nodeIds: f.nodeIds.filter((id) => !refusals.some((x) => x.nodeIds.includes(id) && at(x) >= at(f))) }
        : f,
    )
    .filter(
      (f) =>
        !(
          f.kind === "capability" && !isLift(f) &&
          refusals.some(
            (x) =>
              x.phrase.toLowerCase() === f.phrase.toLowerCase() && at(x) >= at(f),
          )
        ),
    );
  if (kind === "profile") facts.push(...retainedExplicitCapabilities(text, extracted,
    [...facts, ...parsed.facts.filter(f => f.subjectType === "career_context")]));
  // Positive-only retrieval text: a refusal must not attract that work through its embedding.
  const positiveText = facts
    .filter((f) => f.kind === "capability" && !isLift(f))
    .map((f) => f.phrase)
    .join("\n");
  const embeddingResult = await ai.embedding.embed(
    [
      positiveText || "нет подтвержденных способностей",
      ...facts.map((f) => f.phrase),
    ],
    { ...meta, operationType: "matching_fact_embeddings" },
  );
  const vectors = embeddingResult.data.vectors;
  if (
    vectors.length !== facts.length + 1 ||
    vectors.some(
      (v) =>
        v.length !== 1536 ||
        v.some((x) => !Number.isFinite(x)) ||
        !v.some((x) => x !== 0),
    )
  )
    throw new Error("Invalid semantic embeddings");
  let finalFacts = facts.map((f, i) => ({ ...f, embedding: vectors[i + 1]! }));
  let addedFacts = finalFacts;
  let documentEmbedding = vectors[0]!;
  let guardRejected: { op: string; reason: string }[] = [];
  if (kind === "profile") {
    type Ordered = PreparedFact & { messageOrder?: MessageOrder };
    let all: Ordered[] = finalFacts;
    let history: PreparedFact[] = [];
    let removedMarkers: PreparedFact[] = [];
    const namesOfNode = new Map(nodes.map((n) => [n.id, [n.nameRu, ...synonyms.filter((s) => s.ontologyNodeId === n.id).map((s) => s.phraseRu)]]));
    if (prior && update) {
      // Ответ модели — предложение, а не команда (QA 2026-10-14, №4/№5): guardProfileUpdate принимает
      // только операции, основанные на новом сообщении и относящиеся к конкретному пункту; остальные
      // пункты профиля неизменяемы. Снятые ограничения уходят в историю (kind=superseded).
      const priorActive = prior.facts.filter((f) => (f.kind as string) !== SUPERSEDED_KIND);
      const guard = guardProfileUpdate({ message: text, prior: priorActive, items: update.items, byId: update.byId,
        added: finalFacts, removes: parsed.removes ?? [], nodeNames: (id) => namesOfNode.get(id) ?? [] });
      guardRejected = guard.rejected;
      // Пункт, убранный пользователем кнопкой (removed_by_user, 2026-10-17), — не состояние для guard, но правило то же,
      // что для восстановления снятого навыка: вернуть его может только сообщение, которое называет именно этот пункт
      // (его фразу/подпись или название его узла). Повтор старого текста или «чужой» факт моделью — отклоняется.
      const userRemoved = prior.facts.filter((f) => isUserRemovedMarker(f));
      const blockedRestore = (f: PreparedFact) => userRemoved.some((m) => {
        const identity = { family: userRemovedFamily(m)!, nodeIds: m.nodeIds, key: itemKey(m.label || m.phrase) };
        if (!factRelatesToItem(f, identity)) return false;
        const names = [m.phrase, m.label ?? "", ...m.nodeIds.filter((n) => f.nodeIds.includes(n)).flatMap((n) => namesOfNode.get(n) ?? [])];
        return !names.some((t) => !!t && namedIn(text, t));
      });
      const guardAdded = guard.added.filter((f) => {
        if (!blockedRestore(f)) return true;
        guardRejected.push({ op: `add ${f.kind}:${f.phrase}`, reason: "restore of a user-removed item the message does not mention" });
        return false;
      });
      addedFacts = guardAdded;
      history = prior.facts.filter((f) => (f.kind as string) === SUPERSEDED_KIND);
      removedMarkers = guard.history;
      const kept = priorActive.filter((f) => !guard.dropped.has(f)).map((f): Ordered => ({ ...f, messageOrder: PRIOR_ORDER }));
      const added = guardAdded.map((f): Ordered => ({ ...f,
        messageOrder: { seg: 1, pos: NEW_MESSAGE_POS + Math.max(0, text.lastIndexOf(f.evidence)) } }));
      // Отзыв навыка, который guard снял по сообщению, — тоже отзыв (в «Ограничениях» не показывается).
      scopeRefusalsOfPriorSkills(added, [...guard.dropped]);
      inheritRevokes(added, prior.facts);
      all = [...kept, ...added];
    }
    // Новая отрицательная информация («продал машину», «больше не работаю таксистом»)
    // переопределяет старую положительную (при обновлении — прежнее состояние профиля).
    const resolvedFacts = resolveProfileNegatives(all, fullText);
    const droppedCapability = all.some((f) => f.kind === "capability" && !resolvedFacts.includes(f) && f.constraintType !== "exclusion");
    // Явные ограничения: снятые/заменённые пользователем остаются инертной историей (kind=superseded).
    const liftedRefusals = all.filter((f) => !resolvedFacts.includes(f) && (f.kind === "exclude" || f.constraintType === "exclusion"));
    const restrictions = resolveRestrictionUpdates(resolvedFacts, fullText);
    finalFacts = deduplicateProfileResourceFacts([
      ...restrictions.facts,
      ...[...liftedRefusals, ...restrictions.superseded].map(toSupersededMarker),
      ...restrictions.lifts.map(toLiftMarker),
      ...removedMarkers,
      ...history,
    ].map(({ messageOrder: _order, ...f }: Ordered) => f), fullText);
    if (droppedCapability || prior) {
      // Положительный retrieval-текст не должен притягивать отменённые навыки; при обновлении он
      // собирается из всего итогового профиля, а не только из нового сообщения.
      const positive = finalFacts.filter((f) => f.kind === "capability").map((f) => f.phrase).join("\n");
      // Части составных фактов после прямого удаления кнопкой (2026-10-17) приходят без вектора: тем же вызовом.
      const missing = finalFacts.filter((f) => (f.kind as string) !== SUPERSEDED_KIND && !f.embedding?.length);
      const vectorsNow = (await ai.embedding.embed([positive || "нет подтвержденных способностей", ...missing.map((f) => f.phrase)],
        { ...meta, operationType: "matching_fact_embeddings" })).data.vectors;
      const docVector = vectorsNow[0];
      if (!docVector || docVector.length !== 1536 || !docVector.some((x) => x !== 0) || vectorsNow.length !== missing.length + 1) throw new Error("Invalid semantic embeddings");
      documentEmbedding = docVector;
      if (missing.length) finalFacts = finalFacts.map((f) => { const i = missing.indexOf(f); return i < 0 ? f : { ...f, embedding: vectorsNow[i + 1]! }; });
    }
  }
  // Характеристики бывают только у имеющегося ресурса; у навыка, отказа, отсутствующего ресурса их нет.
  if (kind === "profile")
    finalFacts = finalFacts.map((f) => {
      const { itemRef: _ref, ...rest } = f;
      void _ref;
      // Маркер снятого кнопкой ограничения хранит в attributes свою полную подпись (restriction_signature) — не терять.
      const keep = (f.kind === "resource" && isUserAssetResource(f)) || ((f.kind as string) === SUPERSEDED_KIND && !!liftedMarkerSignature(f as never)) ||
        hasStaleEffectiveText(f);
      return keep ? rest : { ...rest, attributes: [] };
    });
  return {
    processingVersion: `${PIPELINE_VERSION}:${ontologyVersion}:${hash(normalized.model + embeddingResult.model).slice(0, 8)}${kind === "profile" ? ":ri1" : ""}`,
    sourceHash: hash(fullText),
    sourceText: fullText,
    embeddingModel: embeddingResult.model,
    embedding: documentEmbedding,
    facts: finalFacts,
    addedFacts,
    ...(guardRejected.length ? { rejectedOperations: guardRejected } : {}),
  };
}

export async function persistDocument(
  tx: Tx,
  owner: { profileId: string } | { orderId: string },
  doc: PreparedDocument,
) {
  // Every caller locks the owner before writing. Unique indexes are a final retry barrier.
  const ownerWhere =
    "profileId" in owner
      ? eq(schema.matchingDocuments.profileId, owner.profileId)
      : eq(schema.matchingDocuments.orderId, owner.orderId);
  const [existing] = await tx
    .select()
    .from(schema.matchingDocuments)
    .where(
      and(
        ownerWhere,
        eq(schema.matchingDocuments.processingVersion, doc.processingVersion),
        eq(schema.matchingDocuments.sourceHash, doc.sourceHash),
      ),
    );
  if (existing) return { id: existing.id, reused: true };
  const { facts: inputFacts, ...document } = doc;
  const facts = "profileId" in owner ? deduplicateProfileResourceFacts(inputFacts, doc.sourceText) : inputFacts;
  const [inserted] = await tx
    .insert(schema.matchingDocuments)
    .values({ ...owner, ...document })
    .returning();
  if (!inserted) throw new Error("Failed to persist matching document");
  if (facts.length)
    await tx
      .insert(schema.matchingFacts)
      .values(
        facts.map((f) => ({
          documentId: inserted.id,
          kind: f.kind,
          constraintType: f.constraintType ?? "none",
          constraintScope: f.constraintScope ?? "fact",
          resourceRole: f.resourceRole ?? "none",
          resourceCapacity: f.resourceCapacity ?? { value: null, unit: null, kind: null },
          phrase: f.phrase,
          label: f.label ?? null,
          attributes: f.attributes ?? [],
          evidence: f.evidence,
          nodeIds: f.nodeIds,
          confidence: String(f.confidence),
          mandatory: f.mandatory,
          startHour: f.startHour,
          endHour: f.endHour,
          daysOfWeek: f.daysOfWeek ?? null,
          embedding: f.embedding,
        })),
      );
  if ("profileId" in owner) {
    const priorCaps = await tx
      .select()
      .from(schema.userCapabilities)
      .where(eq(schema.userCapabilities.capabilityProfileId, owner.profileId));
    const priorResources = await tx
      .select()
      .from(schema.userResources)
      .where(eq(schema.userResources.capabilityProfileId, owner.profileId));
    await tx
      .delete(schema.userCapabilities)
      .where(eq(schema.userCapabilities.capabilityProfileId, owner.profileId));
    await tx
      .delete(schema.userResources)
      .where(eq(schema.userResources.capabilityProfileId, owner.profileId));
    const seen = new Set<string>();
    for (const f of facts)
      for (const nodeId of f.nodeIds) {
        // missing / provided_by_customer / compatibility — ограничения для matching, не активы исполнителя.
        if (f.kind === "resource" && !isUserAssetResource(f)) continue;
        // Пункт с собственной подписью (2026-10-15) — отдельная строка даже при общем узле: «Машина» и
        // «Грузовая машина» — возможно, два объекта. Пункты без подписи (прежние данные) — как раньше, по узлу.
        const key = f.label ? `${f.kind}:${nodeId}:${normalizeProfileItemIdentity(f.label)}` : `${f.kind}:${nodeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const oldCap = priorCaps.find((c) => c.ontologyNodeId === nodeId);
        const oldResource = priorResources.find(
          (r) => r.ontologyNodeId === nodeId,
        );
        if (f.kind === "capability")
          await tx
            .insert(schema.userCapabilities)
            .values({
              capabilityProfileId: owner.profileId,
              ontologyNodeId: nodeId,
              label: f.label || f.phrase,
              evidenceType: oldCap?.evidenceType ?? "explicit",
              proficiency: oldCap?.proficiency ?? "unknown",
              confidence: String(f.confidence),
            });
        if (f.kind === "resource")
          await tx
            .insert(schema.userResources)
            .values({
              capabilityProfileId: owner.profileId,
              ontologyNodeId: nodeId,
              label: f.label || f.phrase,
              evidenceType: oldResource?.evidenceType ?? "explicit",
              resourceType: oldResource?.resourceType ?? "other",
              attributes: oldResource?.attributes ?? {},
              confidence: String(f.confidence),
            });
      }
  } else {
    await tx
      .delete(schema.orderRequirements)
      .where(eq(schema.orderRequirements.orderId, owner.orderId));
    const seen = new Set<string>();
    for (const f of facts)
      for (const nodeId of f.nodeIds) {
        if (f.kind !== "capability" && f.kind !== "resource") continue;
        const type = `${f.mandatory ? "required" : "desired"}_${f.kind}`;
        if (seen.has(`${type}:${nodeId}`)) continue;
        seen.add(`${type}:${nodeId}`);
        await tx
          .insert(schema.orderRequirements)
          .values({
            orderId: owner.orderId,
            ontologyNodeId: nodeId,
            requirementType: type,
            isMandatory: f.mandatory,
          });
      }
  }
  return { id: inserted.id, reused: false };
}

export async function requestRematch(tx: Tx, userId: string) {
  await tx
    .insert(schema.rematchRequests)
    .values({ userId })
    .onConflictDoUpdate({
      target: schema.rematchRequests.userId,
      set: { requestedAt: sql`now()`, cursor: null },
    });
}

/**
 * Positive concepts the ontology does not know yet (no node): owned/required resources and
 * capabilities. Refusals, absent/customer-supplied resources and compatibility checks are not
 * concepts the person or order brings, so they are not proposed. Pure: no DB access.
 */
const NON_CANDIDATE_ROLES = new Set(["missing", "provided_by_customer", "compatibility"]);
export function unknownConceptPhrases(facts: Pick<PreparedFact, "kind" | "nodeIds" | "phrase" | "constraintType" | "resourceRole">[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of facts) {
    if (f.kind !== "capability" && f.kind !== "resource") continue;
    if (f.nodeIds.length || f.constraintType === "exclusion") continue;
    if (f.kind === "resource" && f.resourceRole && NON_CANDIDATE_ROLES.has(f.resourceRole)) continue;
    const phrase = f.phrase.trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
  }
  return out;
}

/**
 * Unknown concepts go to ontology_candidates for an admin to merge or reject (they never become
 * active nodes automatically). Best-effort, after the document is committed: a failure here must
 * never fail profile/order processing, and the fact itself is already stored without a node.
 */
export async function recordUnknownConcepts(facts: PreparedFact[], traceId: string): Promise<void> {
  try {
    await recordOntologyCandidates(unknownConceptPhrases(facts));
  } catch (error) {
    console.warn("[ontology-candidates] failed to record unknown concepts", {
      traceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Профиль из сообщений по одному (пересборка после отзыва сообщения, переобработка): первое сообщение — как
 * новый профиль, каждое следующее — обновление по одному сообщению поверх результата предыдущих.
 */
/** Названия узлов онтологии — подписи частей составного факта при replay решений кнопкой. */
async function nodeLabels(ids: string[]): Promise<(id: string) => string | null> {
  const unique = [...new Set(ids)];
  if (!unique.length) return () => null;
  const rows = await getDb().select({ id: schema.ontologyNodes.id, name: schema.ontologyNodes.nameRu }).from(schema.ontologyNodes)
    .where(sql`${schema.ontologyNodes.id} in (${sql.join(unique.map((x) => sql`${x}::uuid`), sql`, `)})`);
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return (id) => names.get(id) ?? null;
}

export async function prepareProfileFromMessages(texts: string[], extracted: unknown, traceId: string,
  decisions: ScheduledDecision[] = []): Promise<PreparedDocument> {
  const messages = texts.filter((t) => t.trim());
  const [first, ...rest] = messages;
  if (first === undefined) throw new Error("No profile messages to prepare");
  // Решения пользователя кнопкой (2026-10-17) — между сообщениями по времени, без AI (profile-decisions.ts).
  const memory = new Map<string, PreparedFact[]>();
  const positive = (list: PreparedFact[]) => list.filter((f) => f.kind === "capability" && !isLift(f)).map((f) => f.phrase).join("\n");
  const applyBefore = async (doc: PreparedDocument, index: number) => {
    const due = decisions.filter((d) => d.beforeIndex === index);
    if (!due.length) return { doc, capabilitiesChanged: false };
    const nodeLabel = await nodeLabels(doc.facts.flatMap((f) => f.nodeIds));
    let facts = doc.facts;
    for (const d of due) facts = applyDecision(facts, d.decision, memory, { nodeLabel });
    return { doc: { ...doc, facts }, capabilitiesChanged: positive(facts) !== positive(doc.facts) };
  };
  let doc = await prepareDocument("profile", first, extracted, traceId);
  for (const [i, text] of rest.entries()) {
    doc = (await applyBefore(doc, i + 1)).doc;
    doc = await prepareDocument("profile", text, {}, traceId, { sourceText: doc.sourceText, facts: doc.facts });
  }
  const last = await applyBefore(doc, messages.length);
  doc = last.doc;
  const missing = doc.facts.filter((f) => (f.kind as string) !== SUPERSEDED_KIND && !f.embedding?.length);
  if (last.capabilitiesChanged || missing.length) {
    // Вектор документа — из действующих навыков (как при обновлении профиля), и векторы частей составных фактов:
    // 1 вызов embedding, не extraction.
    const result = await getAiProviders().embedding.embed([positive(doc.facts) || "нет подтвержденных способностей", ...missing.map((f) => f.phrase)],
      { operationType: "matching_fact_embeddings", traceId, promptVersion: "v1", schemaVersion: "v1" });
    const vectors = result.data.vectors;
    if (vectors.length !== missing.length + 1 || vectors.some((v) => v.length !== 1536 || !v.some((x) => x !== 0))) throw new Error("Invalid semantic embeddings");
    doc = { ...doc, embedding: vectors[0]!, facts: doc.facts.map((f) => { const i = missing.indexOf(f); return i < 0 ? f : { ...f, embedding: vectors[i + 1]! }; }) };
  }
  return { ...doc, addedFacts: undefined };
}
