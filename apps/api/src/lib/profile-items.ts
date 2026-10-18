import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { normalizeProfileItemIdentity } from "@ustal/domain";
import { loadCurrentProfile, schema, type Database } from "@ustal/database";
import { getRuntimeConfig } from "@ustal/config";
import {
  factMatchesItem, isActiveCapabilityFact, isActiveResourceFact, isLift, isLiftedRestrictionMarker, itemKey, liftedMarkerSignature,
  liftRestrictionFacts, markerSignatureOf, restoreProfileItem, restoreRestrictionFacts, restrictionSignature, revokeProfileItem,
  selectItemFacts, SUPERSEDED_KIND, userRemovedFamily, type ItemFact, type ProfileItemFamily, type ProfileItemIdentity,
} from "@ustal/matching";
import { restrictionGroups } from "./profile-diff.js";

/**
 * Direct revoke/restore пунктов профиля БЕЗ AI (2026-10-17; исправления по аудиту Codex — тот же день).
 *
 * Действие пользователя кнопкой меняет authoritative состояние так же, как это делает worker при обновлении профиля:
 * новая applied-версия (copy-on-write), где пункт стал инертным маркером (removed_by_user — нейтральное «убрать»,
 * НЕ отказ; lifted:<область> — снятое ограничение, тот же маркер, что при снятии сообщением). Сырые сообщения и
 * накопленный текст не меняются. Решение пишется в журнал profile_item_decisions (event/audit; переживает переборку).
 * - идентичность пункта: узел + подпись (узел — не идентичность ресурса), см. selectItemFacts в @ustal/matching;
 *   ограничения — структурная подпись (restrictionSignature), не фраза;
 * - составной факт: убирается/возвращается только выбранная часть;
 * - строки user_capabilities/user_resources выводятся из новых фактов тем же правилом, что в worker (узел + подпись);
 * - lock: тот же advisory lock (userId, 0), что у extraction / rebuild / apply черновика / source revoke;
 * - ожидающий черновик → 409 profile_draft_pending; профиль пересобирается → 409 profile_rebuilding;
 * - id — только поиск в текущей версии; id прежней версии → повтор того же решения = 200 changed:false, иначе 409 stale_item;
 * - чужой/неизвестный/некорректный id → 404 (как в profile-facts);
 * - лимит AI-сообщений не тратится; свой лимит PROFILE_ITEM_ACTIONS_PER_HOUR (только действия, менявшие состояние);
 * - если изменился текст навыков или у новой части факта нет вектора — версия embedding_stale=true (флаг переносится
 *   на следующие версии до пересчёта): matching не использует устаревший вектор; worker пересчитывает ТЕКУЩУЮ версию.
 * AI (extraction/нормализация) не вызывается.
 */
export type ItemKind = ProfileItemFamily | "restriction";
export type ItemAction = "revoke" | "restore";
export const ITEM_KINDS: readonly ItemKind[] = ["capability", "resource", "restriction"];
export const ITEM_ACTIONS: readonly ItemAction[] = ["revoke", "restore"];

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type FactRow = typeof schema.matchingFacts.$inferSelect;
type CapRow = typeof schema.userCapabilities.$inferSelect;
type ResRow = typeof schema.userResources.$inferSelect;
type Fact = FactRow & ItemFact;
type Snapshot = { facts: Omit<FactRow, "id" | "documentId">[]; capabilities: Omit<CapRow, "id" | "capabilityProfileId">[]; resources: Omit<ResRow, "id" | "capabilityProfileId">[] };
type RestrictionIdentity = { kind: "restriction"; signatures: string[]; facts: { phrase: string; evidence: string | null }[] };

export type ItemActionResult =
  | { status: 200; body: { status: "revoked" | "restored"; changed: boolean; profileVersion: number }; refreshEmbedding?: boolean }
  | { status: 404 | 409 | 429; body: { error: { code: string; message: string } } };

const err = (status: 404 | 409 | 429, code: string, message: string): ItemActionResult => ({ status, body: { error: { code, message } } });
const NOT_FOUND = () => err(404, "not_found", "Пункт профиля не найден");
const asFact = (f: FactRow | Omit<FactRow, "id" | "documentId">): Fact =>
  ({ ...f, nodeIds: (f.nodeIds ?? []) as string[], confidence: Number(f.confidence) } as unknown as Fact);
const strip = <T extends { id?: unknown; documentId?: unknown }>(f: T) => { const { id: _i, documentId: _d, ...rest } = f; void _i; void _d; return rest; };
const stripItem = <T extends { id?: unknown; capabilityProfileId?: unknown }>(r: T) => { const { id: _i, capabilityProfileId: _p, ...rest } = r; void _i; void _p; return rest; };
const positiveText = (facts: Fact[]) => facts.filter((f) => f.kind === "capability" && !isLift(f)).map((f) => f.phrase).join("\n");
const needsVector = (f: Fact) => f.kind !== SUPERSEDED_KIND && !(f.embedding as number[] | null)?.length;

async function loadState(tx: Tx, profileId: string) {
  const doc = await tx.query.matchingDocuments.findFirst({
    where: eq(schema.matchingDocuments.profileId, profileId), orderBy: desc(schema.matchingDocuments.processedAt),
  });
  const [facts, caps, res] = await Promise.all([
    doc ? tx.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc.id)) : Promise.resolve([] as FactRow[]),
    tx.select().from(schema.userCapabilities).where(eq(schema.userCapabilities.capabilityProfileId, profileId)),
    tx.select().from(schema.userResources).where(eq(schema.userResources.capabilityProfileId, profileId)),
  ]);
  return { doc, facts: facts.map(asFact), caps, res };
}
type State = Awaited<ReturnType<typeof loadState>>;

/** Названия узлов онтологии — подписи частей составного факта. */
async function nodeLabels(tx: Tx, facts: Fact[]) {
  const ids = [...new Set(facts.flatMap((f) => f.nodeIds))];
  const rows = ids.length ? await tx.select({ id: schema.ontologyNodes.id, name: schema.ontologyNodes.nameRu }).from(schema.ontologyNodes)
    .where(inArray(schema.ontologyNodes.id, ids)) : [];
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return (id: string) => names.get(id) ?? null;
}

/** Пункт текущей версии по id: строка навыка/ресурса (узел + подпись) или факт без узла (неизвестный пункт). */
function identityOf(state: State, kind: ProfileItemFamily, id: string): ProfileItemIdentity | null {
  const rows = kind === "capability" ? state.caps : state.res;
  const row = rows.find((r) => r.id === id);
  if (row) return { family: kind, nodeIds: [row.ontologyNodeId], key: itemKey(row.label) };
  const fact = state.facts.find((f) => f.id === id);
  const active = kind === "capability" ? isActiveCapabilityFact : isActiveResourceFact;
  if (fact && !fact.nodeIds.length && active(fact)) return { family: kind, nodeIds: [], key: itemKey(fact.label || fact.phrase) };
  return null;
}
const markerIdentity = (m: ItemFact, family: ProfileItemFamily): ProfileItemIdentity => ({ family, nodeIds: m.nodeIds, key: itemKey(m.label || m.phrase) });
const covers = (o: ItemFact, m: ItemFact) => (m.nodeIds.length ? m.nodeIds.every((n) => o.nodeIds.includes(n)) : !o.nodeIds.length && itemKey(o.label || o.phrase) === itemKey(m.label || m.phrase));

async function revokeDecisions(tx: Tx, userId: string, family: ItemKind) {
  return tx.select().from(schema.profileItemDecisions)
    .where(and(eq(schema.profileItemDecisions.userId, userId), eq(schema.profileItemDecisions.family, family), eq(schema.profileItemDecisions.action, "revoke")))
    .orderBy(desc(schema.profileItemDecisions.decidedAt), desc(schema.profileItemDecisions.seq));
}
/** Исходный факт убранного пункта (журнал): та же цитата и узлы маркера (или та же подпись без узла). */
const snapshotOfMarker = (decisions: { snapshot: unknown }[], m: ItemFact) =>
  decisions.map((d) => d.snapshot as Snapshot).find((s) => s.facts.some((o) => (o.evidence ?? null) === (m.evidence ?? null) && covers(asFact(o), m)));
/** Решение «снять ограничение» по маркеру: структурная подпись (область, предмет, час), не фраза. */
const decisionOfLifted = <D extends { snapshot: unknown }>(decisions: D[], m: ItemFact) => {
  const msig = liftedMarkerSignature(m);
  return decisions.find((d) => (d.snapshot as Snapshot).facts.some((o) => markerSignatureOf(asFact(o)) === msig));
};

/**
 * Строки user_capabilities/user_resources из фактов — то же правило, что persistDocument в worker: на каждый узел
 * действующего навыка/ресурса-актива; пункт с подписью — отдельная строка «узел + подпись». Прочие поля — из прежних
 * строк (та же подпись, иначе тот же узел) или из строк журнала при восстановлении.
 */
function deriveRows(facts: Fact[], profileId: string, prior: { caps: Omit<CapRow, "id" | "capabilityProfileId">[]; res: Omit<ResRow, "id" | "capabilityProfileId">[] }) {
  const caps: (typeof schema.userCapabilities.$inferInsert)[] = [];
  const res: (typeof schema.userResources.$inferInsert)[] = [];
  const seen = new Set<string>();
  const same = <R extends { ontologyNodeId: string; label: string }>(rows: R[], node: string, label: string) =>
    rows.find((r) => r.ontologyNodeId === node && normalizeProfileItemIdentity(r.label) === normalizeProfileItemIdentity(label)) ??
    rows.find((r) => r.ontologyNodeId === node);
  for (const f of facts)
    for (const nodeId of f.nodeIds) {
      if (f.kind === "resource" && !isActiveResourceFact(f)) continue;
      if (f.kind !== "capability" && f.kind !== "resource") continue;
      const key = f.label ? `${f.kind}:${nodeId}:${normalizeProfileItemIdentity(f.label)}` : `${f.kind}:${nodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = f.label || f.phrase;
      if (f.kind === "capability") {
        const old = same(prior.caps, nodeId, label);
        caps.push({ capabilityProfileId: profileId, ontologyNodeId: nodeId, label, evidenceType: old?.evidenceType ?? "explicit",
          proficiency: old?.proficiency ?? "unknown", confidence: String(f.confidence) });
      } else {
        const old = same(prior.res, nodeId, label);
        res.push({ capabilityProfileId: profileId, ontologyNodeId: nodeId, label, evidenceType: old?.evidenceType ?? "explicit",
          resourceType: old?.resourceType ?? "other", attributes: old?.attributes ?? {}, confidence: String(f.confidence) });
      }
    }
  return { caps, res };
}

/** id из другой версии этого пользователя (для идемпотентного повтора и stale). */
async function findInOtherVersions(tx: Tx, userId: string, kind: ItemKind, id: string) {
  const owned = sql`exists (select 1 from capability_profiles cp where cp.id = x.capability_profile_id and cp.user_id = ${userId})`;
  if (kind !== "restriction") {
    const table = kind === "capability" ? sql`user_capabilities` : sql`user_resources`;
    const [row] = await tx.execute<{ ontology_node_id: string; label: string }>(
      sql`select x.ontology_node_id, x.label from ${table} x where x.id = ${id} and ${owned}`);
    if (row) return { identity: { family: kind, nodeIds: [row.ontology_node_id], key: itemKey(row.label) } as ProfileItemIdentity, fact: null };
  }
  const [fact] = await tx.select({ f: schema.matchingFacts }).from(schema.matchingFacts)
    .innerJoin(schema.matchingDocuments, eq(schema.matchingDocuments.id, schema.matchingFacts.documentId))
    .innerJoin(schema.capabilityProfiles, eq(schema.capabilityProfiles.id, schema.matchingDocuments.profileId))
    .where(and(eq(schema.matchingFacts.id, id), eq(schema.capabilityProfiles.userId, userId)));
  if (!fact) return null;
  const f = asFact(fact.f);
  const family = kind === "restriction" ? null : kind;
  return { identity: family ? markerIdentity(f, family) : null, fact: f };
}

export async function applyProfileItemAction(db: Database, input: { userId: string; kind: ItemKind; id: string; action: ItemAction }): Promise<ItemActionResult> {
  const { userId, kind, id, action } = input;
  const done = (changed: boolean, profileVersion: number, refreshEmbedding = false): ItemActionResult =>
    ({ status: 200, body: { status: action === "revoke" ? "revoked" : "restored", changed, profileVersion }, ...(refreshEmbedding ? { refreshEmbedding } : {}) });

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    const current = await loadCurrentProfile(tx, userId);
    if (!current) return NOT_FOUND();
    if (current.status === "rebuild_pending") return err(409, "profile_rebuilding", "Профиль обновляется. Повторите через минуту.");
    const draft = await tx.query.capabilityProfiles.findFirst({
      where: and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "draft")),
    });
    if (draft) return err(409, "profile_draft_pending", "Сначала примените или отклоните предложенные изменения профиля.");
    const state = await loadState(tx, current.id);
    if (!state.doc) return NOT_FOUND();
    const nodeLabel = await nodeLabels(tx, state.facts);

    // ---- поиск пункта и новые факты ----
    let next: Fact[] | null = null;
    let removedFacts: Fact[] = [];
    let identity: ProfileItemIdentity | RestrictionIdentity | null = null;
    let restoreSnapshot: Snapshot | null = null;
    if (kind !== "restriction" && action === "revoke") {
      const item = identityOf(state, kind, id);
      if (item) { identity = item; const r = revokeProfileItem(state.facts, item, { nodeLabel }); next = r.facts; removedFacts = r.removed; }
    } else if (kind !== "restriction") {
      const marker = state.facts.find((f) => f.id === id && userRemovedFamily(f) === kind);
      if (marker) {
        identity = markerIdentity(marker, kind);
        restoreSnapshot = snapshotOfMarker(await revokeDecisions(tx, userId, kind), marker) ?? { facts: [], capabilities: [], resources: [] };
        const r = restoreProfileItem(state.facts, identity, restoreSnapshot.facts.map(asFact), { nodeLabel });
        next = r.changed ? r.facts : state.facts;
      }
    } else if (action === "revoke") {
      const group = restrictionGroups(state.facts).find((g) => g.factIds.includes(id));
      if (group) {
        const ids = new Set(group.factIds);
        const r = liftRestrictionFacts(state.facts, (f) => ids.has(f.id), { nodeLabel });
        next = r.facts; removedFacts = r.removed;
        identity = { kind: "restriction", signatures: r.removed.map(restrictionSignature).filter((x): x is string => !!x),
          facts: r.removed.map((f) => ({ phrase: f.phrase, evidence: f.evidence ?? null })) };
      }
    } else {
      const marker = state.facts.find((f) => f.id === id && isLiftedRestrictionMarker(f));
      if (marker) {
        const decision = decisionOfLifted(await revokeDecisions(tx, userId, "restriction"), marker);
        if (!decision) return NOT_FOUND(); // снято сообщением, а не кнопкой: восстановление — новым сообщением
        restoreSnapshot = decision.snapshot as Snapshot;
        identity = decision.identity as RestrictionIdentity;
        const r = restoreRestrictionFacts(state.facts, restoreSnapshot.facts.map(asFact));
        next = r.changed ? r.facts : state.facts;
      }
    }

    // ---- id не из текущей версии: повтор (идемпотентно) / устаревший / чужой ----
    if (!identity || !next) {
      const other = await findInOtherVersions(tx, userId, kind, id);
      if (!other) return NOT_FOUND();
      if (other.identity) {
        const active = selectItemFacts(state.facts, other.identity).length > 0;
        const marker = state.facts.some((f) => userRemovedFamily(f) === other.identity!.family && factMatchesItem(f, other.identity!, other.identity!.family));
        if (action === "revoke" && !active && marker) return done(false, current.profileVersion);
        if (action === "restore" && active && !marker) return done(false, current.profileVersion);
      } else if (other.fact) {
        // Ограничение — по структурной подписи (живой факт → его подпись; маркер → подпись маркера).
        const msig = isLiftedRestrictionMarker(other.fact) ? liftedMarkerSignature(other.fact) : markerSignatureOf(other.fact);
        const lifted = state.facts.some((f) => liftedMarkerSignature(f) === msig);
        const live = state.facts.some((f) => f.kind !== SUPERSEDED_KIND && restrictionSignature(f) != null && markerSignatureOf(f) === msig);
        if (action === "revoke" && lifted && !live) return done(false, current.profileVersion);
        if (action === "restore" && live && !lifted) return done(false, current.profileVersion);
      }
      return err(409, "stale_item", "Профиль изменился. Обновите его и повторите.");
    }
    if (next === state.facts || (action === "revoke" && !removedFacts.length)) return done(false, current.profileVersion);

    // ---- лимит прямых действий (только меняющие состояние) ----
    const limit = getRuntimeConfig().rateLimits.profileItemActionsPerHour;
    const [recent] = await tx.execute<{ n: number }>(sql`select count(*)::int n from profile_item_decisions
      where user_id = ${userId} and decided_at > now() - interval '1 hour'`);
    if ((recent?.n ?? 0) >= limit) return err(429, "rate_limited", `Не более ${limit} изменений профиля кнопками в час`);

    // ---- новая applied-версия (copy-on-write, без AI) ----
    const [maxRow] = await tx.execute<{ v: number }>(sql`select coalesce(max(profile_version), 0)::int v from capability_profiles where user_id = ${userId}`);
    // Вектор документа копируется; если текст навыков изменился или у новой части факта нет вектора — версия
    // помечается embedding_stale (и флаг прежней версии переносится, пока worker его не сбросил): matching не
    // использует устаревший вектор как сигнал до пересчёта (fail-safe).
    const refresh = positiveText(next) !== positiveText(state.facts) || next.some((f) => !state.facts.includes(f) && needsVector(f));
    const [created] = await tx.insert(schema.capabilityProfiles).values({
      userId, summary: current.summary, profileVersion: (maxRow?.v ?? 0) + 1, extractionVersion: current.extractionVersion,
      embeddingModel: current.embeddingModel, sourceInputId: null, status: "applied", embeddingStale: refresh || current.embeddingStale,
    }).returning();
    if (!created) throw new Error("Failed to create profile version");
    await tx.update(schema.capabilityProfiles).set({ status: "superseded" }).where(eq(schema.capabilityProfiles.id, current.id));
    const doc = state.doc;
    const [newDoc] = await tx.insert(schema.matchingDocuments).values({
      profileId: created.id, processingVersion: doc.processingVersion, sourceHash: doc.sourceHash, sourceText: doc.sourceText,
      embeddingModel: doc.embeddingModel, embedding: doc.embedding,
    }).returning();
    if (!newDoc) throw new Error("Failed to copy matching document");
    const toRow = (f: Fact) => ({ ...strip(f as unknown as FactRow), confidence: String(f.confidence), documentId: newDoc.id }) as typeof schema.matchingFacts.$inferInsert;
    if (next.length) await tx.insert(schema.matchingFacts).values(next.map(toRow));

    // Строки навыков/ресурсов (канонический retrieval) — из новых фактов тем же правилом, что в worker.
    const family = kind === "restriction" ? null : kind;
    const rows = deriveRows(next, created.id, {
      caps: [...state.caps.map(stripItem), ...(restoreSnapshot?.capabilities ?? [])],
      res: [...state.res.map(stripItem), ...(restoreSnapshot?.resources ?? [])],
    });
    if (rows.caps.length) await tx.insert(schema.userCapabilities).values(rows.caps);
    if (rows.res.length) await tx.insert(schema.userResources).values(rows.res);
    const embeddings = await tx.select().from(schema.profileEmbeddings).where(eq(schema.profileEmbeddings.capabilityProfileId, current.id));
    if (embeddings.length)
      await tx.insert(schema.profileEmbeddings).values(embeddings.map(({ capabilityProfileId: _p, ...e }) => { void _p; return { ...e, capabilityProfileId: created.id }; }));

    const keptCaps = new Set(rows.caps.map((c) => `${c.ontologyNodeId}:${normalizeProfileItemIdentity(c.label)}`));
    const keptRes = new Set(rows.res.map((r) => `${r.ontologyNodeId}:${normalizeProfileItemIdentity(r.label)}`));
    const snapshot: Snapshot = action === "revoke"
      ? { facts: removedFacts.map((f) => strip(f as unknown as FactRow)),
          capabilities: family === "capability" ? state.caps.filter((c) => !keptCaps.has(`${c.ontologyNodeId}:${normalizeProfileItemIdentity(c.label)}`)).map(stripItem) : [],
          resources: family === "resource" ? state.res.filter((r) => !keptRes.has(`${r.ontologyNodeId}:${normalizeProfileItemIdentity(r.label)}`)).map(stripItem) : [] }
      : restoreSnapshot!;
    await tx.insert(schema.profileItemDecisions).values({ userId, action, family: kind, identity, snapshot, profileVersion: created.profileVersion });
    // Matching пересчитывается сразу (коалесцирующий rematch); после пересчёта векторов — ещё раз (worker).
    await tx.insert(schema.rematchRequests).values({ userId })
      .onConflictDoUpdate({ target: schema.rematchRequests.userId, set: { requestedAt: sql`now()`, cursor: null } });
    return done(true, created.profileVersion, created.embeddingStale);
  });
}

/** Убранные кнопкой пункты текущей версии для GET /profile (2026-10-17). Снятое AI-сообщением сюда не входит. */
export async function loadRemovedItems(db: Database, userId: string, facts: FactRow[]) {
  const all = facts.map(asFact);
  const out: { id: string; kind: ItemKind; label: string; decidedAt: string | null }[] = [];
  const decisions = await db.select().from(schema.profileItemDecisions)
    .where(and(eq(schema.profileItemDecisions.userId, userId), eq(schema.profileItemDecisions.action, "revoke")))
    .orderBy(desc(schema.profileItemDecisions.decidedAt), desc(schema.profileItemDecisions.seq)).limit(500);
  const seen = new Set<string>();
  for (const m of all) {
    const family = userRemovedFamily(m);
    if (!family) continue;
    const identity = markerIdentity(m, family);
    const key = JSON.stringify([family, [...identity.nodeIds].sort(), identity.key]);
    if (seen.has(key) || selectItemFacts(all, identity).length) continue;
    seen.add(key);
    const d = decisions.find((x) => x.family === family && (x.snapshot as Snapshot).facts.some((o) => (o.evidence ?? null) === (m.evidence ?? null) && covers(asFact(o), m)));
    out.push({ id: m.id, kind: family, label: (m.label || m.phrase).trim(), decidedAt: d ? d.decidedAt.toISOString() : null });
  }
  const shown = new Set<string>();
  for (const m of all) {
    if (!isLiftedRestrictionMarker(m)) continue;
    const d = decisionOfLifted(decisions.filter((x) => x.family === "restriction"), m);
    if (!d || shown.has(d.id)) continue;
    const msig = liftedMarkerSignature(m);
    if (all.some((f) => f.kind !== SUPERSEDED_KIND && restrictionSignature(f) != null && markerSignatureOf(f) === msig)) continue;
    shown.add(d.id);
    const label = restrictionGroups((d.snapshot as Snapshot).facts as never)[0]?.text ?? m.phrase;
    out.push({ id: m.id, kind: "restriction", label, decidedAt: d.decidedAt.toISOString() });
  }
  return out;
}
