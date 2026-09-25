/**
 * Дифф черновика профиля по ontologyNodeId (а не по label): тот же узел с другой
 * формулировкой — тот же пункт, не «убрать + добавить».
 * added — пункты черновика, узла которых нет в применённом профиле (label из черновика).
 * removed — пункты применённого профиля, узла которых нет в черновике (label из применённого).
 */
export interface DiffItem {
  ontologyNodeId: string;
  label: string;
}

export function diffByNode(applied: DiffItem[], draft: DiffItem[]): { added: string[]; removed: string[] } {
  const appliedIds = new Set(applied.map((i) => i.ontologyNodeId));
  const draftIds = new Set(draft.map((i) => i.ontologyNodeId));
  return {
    added: draft.filter((i) => !appliedIds.has(i.ontologyNodeId)).map((i) => i.label),
    removed: applied.filter((i) => !draftIds.has(i.ontologyNodeId)).map((i) => i.label),
  };
}

/**
 * Распознанные AI фразы профиля без ontology-узла (matching_facts.node_ids = []).
 * Matching уже использует их через embedding, но в user_capabilities/user_resources
 * они не попадают — отдаём отдельно, чтобы пользователь видел всё распознанное.
 * Ресурсы заказчика/отсутствующие/«совместимость» — не активы исполнителя, не показываем.
 */
export interface UnmappedFact {
  kind: "capability" | "resource";
  phrase: string;
}
export interface FactRow {
  kind: string;
  phrase: string;
  nodeIds: string[];
  resourceRole?: string | null;
  constraintType?: string | null;
}
const HIDDEN_RESOURCE_ROLES = new Set(["missing", "provided_by_customer", "compatibility"]);
const norm = (s: string) => s.trim().toLowerCase();

export function pickUnmappedFacts(facts: FactRow[], mappedLabels: string[] = []): UnmappedFact[] {
  const seen = new Set(mappedLabels.map(norm));
  const out: UnmappedFact[] = [];
  for (const f of facts) {
    if (f.kind !== "capability" && f.kind !== "resource") continue;
    if (f.nodeIds.length) continue;
    // Отказ («больше не делаю …») — ограничение для matching, а не текущий навык.
    if (f.constraintType === "exclusion") continue;
    if (f.kind === "resource" && f.resourceRole && HIDDEN_RESOURCE_ROLES.has(f.resourceRole)) continue;
    const key = norm(f.phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: f.kind, phrase: f.phrase.trim() });
  }
  return out;
}

/** Новые нераспознанные онтологией фразы черновика относительно применённого профиля. */
export function diffUnmapped(applied: UnmappedFact[], draft: UnmappedFact[]): string[] {
  const appliedKeys = new Set(applied.map((f) => norm(f.phrase)));
  return draft.filter((f) => !appliedKeys.has(norm(f.phrase))).map((f) => f.phrase);
}
