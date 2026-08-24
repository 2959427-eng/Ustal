import { getDb, schema } from "@ustal/database";
import { eq } from "drizzle-orm";

export interface OntologyMatch {
  ontologyNodeId: string;
  canonicalKey: string;
  matchedVia: "canonical_key" | "synonym";
}

/**
 * Сопоставляет свободную фразу (из AI-extraction) с активным узлом онтологии
 * по точному совпадению canonical_key или синониму. Раздел 11 ТЗ: LLM не
 * может создавать активные узлы — если совпадения нет, вызывающий код должен
 * создать ontology_candidates запись (см. createOntologyCandidate) и НЕ
 * блокировать безопасный заказ/профиль.
 */
export async function findOntologyNodeForPhrase(phrase: string): Promise<OntologyMatch | null> {
  const db = getDb();
  const normalized = phrase.trim().toLowerCase();

  const byName = await db.query.ontologyNodes.findFirst({
    where: (t, { eq: eqOp, and, sql }) =>
      and(eqOp(t.status, "active"), sql`lower(${t.nameRu}) = ${normalized}`),
  });
  if (byName) return { ontologyNodeId: byName.id, canonicalKey: byName.canonicalKey, matchedVia: "canonical_key" };

  const bySynonym = await db.query.ontologySynonyms.findFirst({
    where: (t, { sql }) => sql`lower(${t.phraseRu}) = ${normalized}`,
  });
  if (bySynonym) {
    const node = await db.query.ontologyNodes.findFirst({
      where: eq(schema.ontologyNodes.id, bySynonym.ontologyNodeId),
    });
    if (node) return { ontologyNodeId: node.id, canonicalKey: node.canonicalKey, matchedVia: "synonym" };
  }

  return null;
}

export async function createOntologyCandidate(rawPhrase: string, suggestedNodeIds: string[]): Promise<void> {
  const db = getDb();
  await db.insert(schema.ontologyCandidates).values({
    rawPhrase,
    suggestedNodeIds,
    status: "pending",
  });
}
