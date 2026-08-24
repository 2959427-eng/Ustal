"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@ustal/database";
import { requireAdminSession } from "../../../lib/session";

/**
 * Раздел 11 ТЗ: LLM не может создавать активные узлы онтологии — не
 * совпавшая фраза копится в ontology_candidates (packages/ontology/src/
 * mapping.ts, createOntologyCandidate) и ждёт здесь решения человека. Merge
 * добавляет фразу синонимом к УЖЕ существующему активному узлу (не создаёт
 * новый узел — это сознательно вне MVP-скоупа админки, добавление новых
 * узлов онтологии требует более осторожного процесса, чем один клик).
 */
export async function mergeOntologyCandidateAction(candidateId: string, formData: FormData) {
  const admin = requireAdminSession();
  const nodeId = String(formData.get("nodeId") ?? "");
  if (!nodeId) throw new Error("Не выбран узел онтологии");

  const db = getDb();
  const candidate = await db.query.ontologyCandidates.findFirst({ where: eq(schema.ontologyCandidates.id, candidateId) });
  if (!candidate || candidate.status !== "pending") throw new Error("Candidate не найден или уже обработан");

  await db.insert(schema.ontologySynonyms).values({ ontologyNodeId: nodeId, phraseRu: candidate.rawPhrase });
  await db
    .update(schema.ontologyCandidates)
    .set({ status: "merged", resolvedByAdminId: admin.sub })
    .where(eq(schema.ontologyCandidates.id, candidateId));

  revalidatePath("/ontology-candidates");
}

export async function rejectOntologyCandidateAction(candidateId: string) {
  const admin = requireAdminSession();
  const db = getDb();
  await db
    .update(schema.ontologyCandidates)
    .set({ status: "rejected", resolvedByAdminId: admin.sub })
    .where(eq(schema.ontologyCandidates.id, candidateId));
  revalidatePath("/ontology-candidates");
}
