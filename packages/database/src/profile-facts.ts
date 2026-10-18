import { and, eq, inArray, notInArray } from "drizzle-orm";
import { profileFacts, profileSourceInputs } from "./schema.js";

/**
 * profile_facts slot resolution (Phase 1 + 2A), shared by the worker (extraction/reprocessing) and the
 * owner API (confirm/correct/revoke). Precedence inside one (user, slot):
 *   user corrected > user confirmed > AI (explicit or inferred)
 * and within the same precedence the fact from the LATER user message wins (then later decision / row).
 * revoked and replaced facts never compete. Exactly one active fact per slot (partial unique index).
 */
export interface SlotCandidate {
  id: string;
  slotKey: string;
  userDecision: string | null;
  sourceCreatedAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
}
const RANK: Record<string, number> = { corrected: 2, confirmed: 1 };
const rank = (f: SlotCandidate) => RANK[f.userDecision ?? ""] ?? 0;

export function planSlotResolution(facts: SlotCandidate[]): Map<string, { status: "active" | "superseded"; supersededBy: string | null }> {
  const winners = new Map<string, SlotCandidate>();
  const time = (d: Date | null) => d?.getTime() ?? 0;
  const better = (a: SlotCandidate, b: SlotCandidate) =>
    rank(a) !== rank(b) ? rank(a) > rank(b)
      : time(a.sourceCreatedAt) !== time(b.sourceCreatedAt) ? time(a.sourceCreatedAt) > time(b.sourceCreatedAt)
        : time(a.decidedAt) !== time(b.decidedAt) ? time(a.decidedAt) > time(b.decidedAt)
          : time(a.createdAt) !== time(b.createdAt) ? time(a.createdAt) > time(b.createdAt) : a.id > b.id;
  for (const f of facts) {
    const w = winners.get(f.slotKey);
    if (!w || better(f, w)) winners.set(f.slotKey, f);
  }
  const plan = new Map<string, { status: "active" | "superseded"; supersededBy: string | null }>();
  for (const f of facts) {
    const w = winners.get(f.slotKey)!;
    plan.set(f.id, w.id === f.id ? { status: "active", supersededBy: null } : { status: "superseded", supersededBy: w.id });
  }
  return plan;
}

// Structural transaction type: works with any drizzle postgres-js transaction or db handle.
type Tx = { select: any; update: any };

/** Recomputes active/superseded for the given slots of one user (idempotent, order-independent). */
export async function resolveProfileFactSlots(tx: Tx, userId: string, slotKeys: string[]) {
  if (!slotKeys.length) return;
  const rows: SlotCandidate[] = await tx.select({
    id: profileFacts.id,
    slotKey: profileFacts.slotKey,
    userDecision: profileFacts.userDecision,
    decidedAt: profileFacts.decidedAt,
    createdAt: profileFacts.createdAt,
    sourceCreatedAt: profileSourceInputs.createdAt,
  }).from(profileFacts)
    .innerJoin(profileSourceInputs, eq(profileSourceInputs.id, profileFacts.sourceInputId))
    .where(and(
      eq(profileFacts.userId, userId),
      inArray(profileFacts.slotKey, [...new Set(slotKeys)]),
      notInArray(profileFacts.status, ["replaced", "revoked"]),
    ));
  if (!rows.length) return;
  const plan = planSlotResolution(rows);
  const now = new Date();
  // Demote first: the partial unique index allows at most one active fact per (user, slot).
  await tx.update(profileFacts).set({ status: "superseded", updatedAt: now })
    .where(inArray(profileFacts.id, rows.map((r) => r.id)));
  const winners = [...plan].filter(([, p]) => p.status === "active").map(([id]) => id);
  if (winners.length)
    await tx.update(profileFacts).set({ status: "active", supersededByFactId: null, updatedAt: now })
      .where(inArray(profileFacts.id, winners));
  for (const winner of winners) {
    const losers = [...plan].filter(([, p]) => p.supersededBy === winner).map(([id]) => id);
    if (losers.length)
      await tx.update(profileFacts).set({ supersededByFactId: winner }).where(inArray(profileFacts.id, losers));
  }
}
