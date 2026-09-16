import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getDb, schema, type Database } from "@ustal/database";
import { semanticResultSchema, type SemanticFact } from "@ustal/validation";

export const PIPELINE_VERSION = "semantic-v2.3";
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
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function prepareDocument(
  kind: "profile" | "order",
  text: string,
  extracted: unknown,
  traceId: string,
): Promise<PreparedDocument> {
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
      extracted,
      ontology: nodes
        .slice(0, 512)
        .map((n) => ({
          canonicalKey: n.canonicalKey,
          name: n.nameRu,
          nodeType: n.nodeType,
          description: n.description,
          synonyms: synonyms.filter((s) => s.ontologyNodeId === n.id).map((s) => s.phraseRu),
        })),
    },
    meta,
  );
  await db
    .insert(schema.aiRuns)
    .values(buildAiRunRecord(meta, started, { result: normalized }));
  const parsed = semanticResultSchema.parse(normalized.data);
  if (parsed.facts.some((f) => !text.includes(f.evidence)))
    throw new Error(
      "Semantic normalization returned unsupported source evidence",
    );

  const resolved = parsed.facts.map((f) => {
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
    if (
      f.kind === "resource" &&
      selectedNodes.length &&
      selectedNodes.every((n) => ["action", "capability"].includes(n.nodeType))
    )
      factKind = "capability";
    if (
      f.kind === "capability" &&
      selectedNodes.length &&
      selectedNodes.every((n) => n.nodeType === "resource")
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
    });
  }
  const excluded = new Set(
    resolved.filter((f) => f.kind === "exclude").flatMap((f) => f.nodeIds),
  );
  const facts = resolved
    .map((f) =>
      f.kind === "capability"
        ? { ...f, nodeIds: f.nodeIds.filter((id) => !excluded.has(id)) }
        : f,
    )
    .filter(
      (f) =>
        !(
          f.kind === "capability" &&
          resolved.some(
            (x) =>
              x.kind === "exclude" &&
              x.phrase.toLowerCase() === f.phrase.toLowerCase(),
          )
        ),
    );
  // Positive-only retrieval text: a refusal must not attract that work through its embedding.
  const positiveText = facts
    .filter((f) => f.kind === "capability")
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
  return {
    processingVersion: `${PIPELINE_VERSION}:${ontologyVersion}:${hash(normalized.model + embeddingResult.model).slice(0, 8)}`,
    sourceHash: hash(text),
    sourceText: text,
    embeddingModel: embeddingResult.model,
    embedding: vectors[0]!,
    facts: facts.map((f, i) => ({ ...f, embedding: vectors[i + 1]! })),
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
  const { facts, ...document } = doc;
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
          evidence: f.evidence,
          nodeIds: f.nodeIds,
          confidence: String(f.confidence),
          mandatory: f.mandatory,
          startHour: f.startHour,
          endHour: f.endHour,
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
        const key = `${f.kind}:${nodeId}`;
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
              label: f.phrase,
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
              label: f.phrase,
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
