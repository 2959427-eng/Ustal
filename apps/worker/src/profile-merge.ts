import { eq } from "drizzle-orm";
import { schema } from "@ustal/database";
import type { persistDocument } from "./semantic.js";

type Tx = Parameters<typeof persistDocument>[0];

/**
 * Правило профиля USTAL: профиль накопительный.
 * - Пункт определяется по ontologyNodeId, а не по label.
 * - Для уже существующего узла сохраняется прежний label (AI не переименовывает пункты).
 * - Отсутствие старого узла в новом ответе AI НЕ означает удаление; удаляем только узлы,
 *   которые пользователь явно исключил (fact.kind === "exclude").
 */
export interface NodeItem {
  ontologyNodeId: string;
}

export interface CarryForwardPlan<T extends NodeItem> {
  /** Прежние пункты, которых нет в новом черновике и которые не исключены явно — переносятся. */
  toInsert: T[];
  /** Пункты, которые есть и в прежнем профиле, и в черновике: в черновике берём прежний label. */
  preserved: Map<string, T>;
}

export function planCarryForward<T extends NodeItem>(
  prior: T[],
  current: NodeItem[],
  excludedNodeIds: ReadonlySet<string>,
): CarryForwardPlan<T> {
  const currentIds = new Set(current.map((c) => c.ontologyNodeId));
  const preserved = new Map<string, T>();
  const toInsert: T[] = [];
  const seen = new Set<string>();
  for (const p of prior) {
    if (seen.has(p.ontologyNodeId)) continue;
    seen.add(p.ontologyNodeId);
    if (currentIds.has(p.ontologyNodeId)) preserved.set(p.ontologyNodeId, p);
    else if (!excludedNodeIds.has(p.ontologyNodeId)) toInsert.push(p);
  }
  return { toInsert, preserved };
}

/**
 * Применяет накопительное правило к только что созданному черновику.
 * Вызывается в той же транзакции, что и persistDocument.
 */
export async function carryForwardProfileItems(
  tx: Tx,
  args: {
    draftProfileId: string;
    draftDocumentId: string;
    previousProfileId: string | undefined;
    excludedNodeIds: ReadonlySet<string>;
    /** Подписи прежних пунктов, отменённые новыми отрицательными фактами (lowercase). */
    supersededLabels?: ReadonlySet<string>;
    /** Узел сохранён другой, не отменённой фразой — её и показываем вместо отменённой подписи. */
    relabel?: ReadonlyMap<string, string>;
  },
) {
  if (!args.previousProfileId) return { carriedCapabilities: 0, carriedResources: 0 };
  const { draftProfileId, previousProfileId, excludedNodeIds } = args;
  // Отменённая подпись («подрабатываю таксистом») не должна переживать отказ на сохранённом узле.
  const labelFor = (nodeId: string, oldLabel: string, fallback: string) =>
    args.supersededLabels?.has(oldLabel.trim().toLowerCase()) ? (args.relabel?.get(nodeId) ?? fallback) : oldLabel;

  const [priorCaps, priorRes, draftCaps, draftRes] = await Promise.all([
    tx.select().from(schema.userCapabilities).where(eq(schema.userCapabilities.capabilityProfileId, previousProfileId)),
    tx.select().from(schema.userResources).where(eq(schema.userResources.capabilityProfileId, previousProfileId)),
    tx.select().from(schema.userCapabilities).where(eq(schema.userCapabilities.capabilityProfileId, draftProfileId)),
    tx.select().from(schema.userResources).where(eq(schema.userResources.capabilityProfileId, draftProfileId)),
  ]);

  const capPlan = planCarryForward(priorCaps, draftCaps, excludedNodeIds);
  const resPlan = planCarryForward(priorRes, draftRes, excludedNodeIds);

  for (const d of draftCaps) {
    const old = capPlan.preserved.get(d.ontologyNodeId);
    if (old)
      await tx
        .update(schema.userCapabilities)
        .set({ label: labelFor(d.ontologyNodeId, old.label, d.label), evidenceType: old.evidenceType, proficiency: old.proficiency })
        .where(eq(schema.userCapabilities.id, d.id));
  }
  for (const d of draftRes) {
    const old = resPlan.preserved.get(d.ontologyNodeId);
    if (old)
      await tx
        .update(schema.userResources)
        .set({ label: labelFor(d.ontologyNodeId, old.label, d.label), evidenceType: old.evidenceType, resourceType: old.resourceType, attributes: old.attributes })
        .where(eq(schema.userResources.id, d.id));
  }
  for (const p of capPlan.toInsert) {
    const { id: _id, capabilityProfileId: _cp, ...rest } = p;
    void _id; void _cp;
    await tx.insert(schema.userCapabilities).values({ ...rest, label: labelFor(p.ontologyNodeId, p.label, p.label), capabilityProfileId: draftProfileId });
  }
  for (const p of resPlan.toInsert) {
    const { id: _id, capabilityProfileId: _cp, ...rest } = p;
    void _id; void _cp;
    await tx.insert(schema.userResources).values({ ...rest, label: labelFor(p.ontologyNodeId, p.label, p.label), capabilityProfileId: draftProfileId });
  }

  // Согласованность с matching: факты прежнего документа для перенесённых узлов копируем в
  // документ черновика (иначе перенесённый пункт был бы виден в профиле, но не в matching).
  const carried = new Set([...capPlan.toInsert, ...resPlan.toInsert].map((p) => p.ontologyNodeId));
  if (carried.size) {
    const priorDoc = await tx.query.matchingDocuments.findFirst({
      where: eq(schema.matchingDocuments.profileId, previousProfileId),
      orderBy: (t, { desc }) => desc(t.processedAt),
    });
    if (priorDoc) {
      const facts = await tx.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, priorDoc.id));
      for (const f of facts) {
        const ids = (f.nodeIds ?? []) as string[];
        if (!ids.length || !ids.every((i) => carried.has(i))) continue;
        if (f.kind !== "capability" && f.kind !== "resource") continue;
        const { id: _id, documentId: _d, ...rest } = f;
        void _id; void _d;
        await tx.insert(schema.matchingFacts).values({ ...rest, documentId: args.draftDocumentId });
      }
    }
  }
  return { carriedCapabilities: capPlan.toInsert.length, carriedResources: resPlan.toInsert.length };
}
