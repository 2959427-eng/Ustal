import { and, asc, eq } from "drizzle-orm";
import { schema } from "@ustal/database";
import {
  liftRestrictionFacts, restoreProfileItem, restoreRestrictionFacts, restrictionSignature, revokeProfileItem, type ItemFact,
  type ItemOptions, type ProfileItemIdentity,
} from "@ustal/matching";

/**
 * Решения пользователя кнопкой (profile_item_decisions, 2026-10-17) при переборке профиля из сообщений
 * (rebuild после отзыва сообщения, reprocess). У такого решения нет сообщения, поэтому replay сообщений его
 * не воспроизвёл бы, и убранный пункт «воскрес» бы из старого текста. Решения применяются детерминированно, без AI,
 * в порядке времени между сообщениями: сообщения до решения → решение → более поздние сообщения (новое явное
 * сообщение вправе вернуть пункт по обычным правилам guard).
 */
type Decision = typeof schema.profileItemDecisions.$inferSelect;
type SnapshotFact = Record<string, unknown> & { phrase: string; evidence?: string | null; confidence?: unknown; nodeIds?: unknown };

export interface ScheduledDecision {
  /** Применяется перед сообщением с этим индексом (длина списка — после последнего сообщения). */
  beforeIndex: number;
  decision: Pick<Decision, "action" | "family" | "identity" | "snapshot">;
}

type Db = { select: (...args: never[]) => unknown };

export async function loadDecisions(db: Db, userId: string): Promise<Decision[]> {
  const q = db as unknown as { select: () => { from: (t: unknown) => { where: (w: unknown) => { orderBy: (...o: unknown[]) => Promise<Decision[]> } } } };
  return q.select().from(schema.profileItemDecisions)
    .where(and(eq(schema.profileItemDecisions.userId, userId)))
    // Полный детерминированный порядок: время решения, затем seq (порядок записи) — при равном времени тоже однозначно.
    .orderBy(asc(schema.profileItemDecisions.decidedAt), asc(schema.profileItemDecisions.seq));
}

/**
 * Расписание решений относительно сообщений. times — время каждого сообщения (в порядке replay);
 * null, если порядок неизвестен (неатрибутируемый legacy-текст) — тогда решения применяются после всех сообщений.
 */
export function scheduleDecisions(decisions: Decision[], times: (Date | null)[]): ScheduledDecision[] {
  const known = times.every((t): t is Date => t instanceof Date);
  return decisions.map((decision) => ({
    beforeIndex: known ? times.filter((t) => t!.getTime() <= decision.decidedAt.getTime()).length : times.length,
    decision,
  }));
}

const toFact = <T extends ItemFact>(f: SnapshotFact): T =>
  ({ ...f, confidence: Number(f.confidence ?? 0), nodeIds: (f.nodeIds ?? []) as string[] } as unknown as T);

/**
 * Применяет одно решение к фактам профиля. memory — исходные факты, убранные в этом replay (для восстановления).
 * Идентичность (аудит Codex 2026-10-17): пункт — узел + подпись, при переформулировке — эмбеддинг исходного факта из
 * журнала; ограничение — структурная подпись (restrictionSignature: область, предмет, часы, дни), не фраза модели.
 */
export function applyDecision<T extends ItemFact>(facts: T[], d: ScheduledDecision["decision"], memory: Map<string, T[]>, options: ItemOptions = {}): T[] {
  // Неоднозначная переформулировка (несколько равных кандидатов) — решение не применяется; это контролируемо логируется.
  const opts: ItemOptions = { ...options, onAmbiguous: options.onAmbiguous ?? ((candidates) => console.log(JSON.stringify({
    event: "profile_item_decision_ambiguous", action: d.action, family: d.family, candidates }))) };
  const snapshotFacts = ((d.snapshot as { facts?: SnapshotFact[] }).facts ?? []).map((f) => toFact<T>(f));
  if (d.family === "restriction") {
    const signatures = new Set(snapshotFacts.map(restrictionSignature).filter((x): x is string => !!x));
    const key = `restriction:${[...signatures].sort().join("|")}`;
    if (d.action === "revoke") {
      const r = liftRestrictionFacts(facts, (f) => signatures.has(restrictionSignature(f) ?? ""), opts);
      if (r.removed.length) memory.set(key, r.removed);
      return r.facts;
    }
    return restoreRestrictionFacts(facts, memory.get(key) ?? snapshotFacts).facts;
  }
  const stored = d.identity as ProfileItemIdentity;
  const source = snapshotFacts.find((f) => (stored.nodeIds.length ? f.nodeIds.some((n) => stored.nodeIds.includes(n)) : true));
  const id: ProfileItemIdentity = { ...stored, embedding: (source?.embedding as number[] | null | undefined) ?? null };
  const key = `${id.family}:${id.nodeIds.join(",")}:${id.key}`;
  if (d.action === "revoke") {
    const r = revokeProfileItem(facts, id, opts);
    if (r.removed.length) memory.set(key, r.removed);
    return r.facts;
  }
  return restoreProfileItem(facts, id, memory.get(key) ?? snapshotFacts, opts).facts;
}
