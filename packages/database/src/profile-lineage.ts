import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { capabilityProfiles, matchingDocuments, profileSourceInputs } from "./schema.js";

/**
 * Source-input lineage of a capability profile (2026-09-28, source revoke lifecycle).
 *
 * The AI profile is cumulative: profile_extraction builds the matching document source as
 *   <previous document sourceText> + PROFILE_SOURCE_SEPARATOR + <text of the new confirmed input>.
 * So every segment of a profile's source is the verbatim text of one user message. The lineage of a
 * profile is the ordered list of those messages. It is used to decide whether a revoked message is
 * still part of the active profile and to rebuild the profile from the remaining (non-revoked) ones.
 *
 * Nothing here edits generated text: the rebuild re-runs the normal AI pipeline over raw inputs.
 */
export const PROFILE_SOURCE_SEPARATOR = "\nПоследнее изменение пользователя:\n";

/** Profile statuses whose source text is (or was) the user's approved profile. */
export const LINEAGE_PROFILE_STATUSES = ["applied", "superseded", "rebuild_pending"] as const;

export function sourceInputText(input: {
  transcriptCorrected: string | null;
  transcript: string | null;
  rawText: string | null;
}): string | null {
  return input.transcriptCorrected ?? input.transcript ?? input.rawText ?? null;
}

export interface LineageCandidate {
  id: string;
  createdAt: Date;
  revokedAt: Date | null;
  text: string;
}

export interface ProfileLineage {
  /** Every segment of the source was matched to a concrete user message. */
  attributable: boolean;
  /** Messages the profile was built from, in source order (fallback: creation order). */
  inputs: LineageCandidate[];
}

/**
 * Pure planner. Each non-empty segment is matched to an unused candidate with the same text; among
 * identical texts a non-revoked message is preferred (the same sentence stated in another, still
 * active message keeps the profile's basis for it), then the earliest one.
 *
 * If any segment cannot be attributed (legacy profiles whose source starts with an AI summary, or a
 * message that itself contains the separator), the lineage falls back to every candidate: a rebuild
 * then starts from raw messages only and drops unattributable text instead of keeping it.
 */
export function planProfileLineage(sourceText: string | null | undefined, candidates: LineageCandidate[]): ProfileLineage {
  const ordered = [...candidates].sort((a, b) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  if (!sourceText) return { attributable: false, inputs: ordered };
  const used = new Set<string>();
  const inputs: LineageCandidate[] = [];
  for (const segment of sourceText.split(PROFILE_SOURCE_SEPARATOR)) {
    const text = segment.trim();
    if (!text) continue;
    const same = ordered.filter((c) => !used.has(c.id) && c.text.trim() === text);
    const match = same.find((c) => !c.revokedAt) ?? same[0];
    if (!match) return { attributable: false, inputs: ordered };
    used.add(match.id);
    inputs.push(match);
  }
  return { attributable: true, inputs };
}

// Structural transaction type: works with any drizzle postgres-js transaction or db handle.
type Tx = { select: any };

/**
 * Loads the lineage of one profile: candidates are the owner's confirmed messages, created no later
 * than the profile, that produced a profile version which was part of the approved profile history.
 */
export async function loadProfileLineage(
  tx: Tx,
  profile: { id: string; userId: string; createdAt: Date },
): Promise<ProfileLineage & { sourceText: string | null }> {
  const [doc] = await tx.select({ sourceText: matchingDocuments.sourceText }).from(matchingDocuments)
    .where(eq(matchingDocuments.profileId, profile.id))
    .orderBy(desc(matchingDocuments.processedAt)).limit(1);
  const rows: Array<{ id: string; createdAt: Date; revokedAt: Date | null; rawText: string | null;
    transcript: string | null; transcriptCorrected: string | null }> = await tx.select({
    id: profileSourceInputs.id,
    createdAt: profileSourceInputs.createdAt,
    revokedAt: profileSourceInputs.revokedAt,
    rawText: profileSourceInputs.rawText,
    transcript: profileSourceInputs.transcript,
    transcriptCorrected: profileSourceInputs.transcriptCorrected,
  }).from(profileSourceInputs).where(and(
    eq(profileSourceInputs.userId, profile.userId),
    eq(profileSourceInputs.status, "confirmed"),
    lte(profileSourceInputs.createdAt, profile.createdAt),
    sql`exists (select 1 from ${capabilityProfiles} cp where cp.source_input_id = ${profileSourceInputs.id}
      and cp.user_id = ${profile.userId} and cp.status in ('applied','superseded','rebuild_pending'))`,
  ));
  const candidates = rows.flatMap((r) => {
    const text = sourceInputText(r);
    return text ? [{ id: r.id, createdAt: r.createdAt, revokedAt: r.revokedAt, text }] : [];
  });
  return { ...planProfileLineage(doc?.sourceText ?? null, candidates), sourceText: doc?.sourceText ?? null };
}

/** The latest profile that currently represents the user (applied, or awaiting rebuild after a revoke). */
export async function loadCurrentProfile(tx: Tx, userId: string) {
  const [row] = await tx.select().from(capabilityProfiles).where(and(
    eq(capabilityProfiles.userId, userId),
    inArray(capabilityProfiles.status, ["applied", "rebuild_pending"]),
  )).orderBy(desc(capabilityProfiles.profileVersion)).limit(1);
  return row as typeof capabilityProfiles.$inferSelect | undefined;
}

/** Messages whose pending draft was invalidated by a revoke/rebuild and that still need re-extraction. */
export async function loadInputsToReextract(tx: Tx, userId: string): Promise<string[]> {
  const rows: Array<{ id: string }> = await tx.select({ id: profileSourceInputs.id }).from(profileSourceInputs).where(and(
    eq(profileSourceInputs.userId, userId),
    eq(profileSourceInputs.status, "confirmed"),
    isNull(profileSourceInputs.revokedAt),
    sql`exists (select 1 from ${capabilityProfiles} cp where cp.source_input_id = ${profileSourceInputs.id} and cp.status = 'invalidated')`,
    sql`not exists (select 1 from ${capabilityProfiles} cp where cp.source_input_id = ${profileSourceInputs.id} and cp.status <> 'invalidated')`,
  )).orderBy(profileSourceInputs.createdAt);
  return rows.map((r) => r.id);
}
