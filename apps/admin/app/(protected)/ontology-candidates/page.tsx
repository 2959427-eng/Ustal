import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { mergeOntologyCandidateAction, rejectOntologyCandidateAction } from "./actions";

const CARD_STYLE: React.CSSProperties = { background: "#fff", borderRadius: 10, padding: 20, marginBottom: 16 };

export default async function OntologyCandidatesPage() {
  const db = getDb();
  const [candidates, nodes] = await Promise.all([
    db.query.ontologyCandidates.findMany({
      where: eq(schema.ontologyCandidates.status, "pending"),
      orderBy: (t, { asc }) => asc(t.createdAt),
      limit: 50,
    }),
    db.query.ontologyNodes.findMany({ where: eq(schema.ontologyNodes.status, "active"), orderBy: (t, { asc }) => asc(t.nameRu) }),
  ]);

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Ontology candidates</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>
        Фразы из AI-извлечения, не совпавшие ни с одним активным узлом онтологии (раздел 11 ТЗ — LLM не создаёт узлы
        сама). Merge добавляет фразу синонимом к выбранному существующему узлу.
      </p>
      {candidates.length === 0 ? <p style={{ color: "#999" }}>Очередь пуста.</p> : null}
      {candidates.map((c) => {
        const rejectBound = rejectOntologyCandidateAction.bind(null, c.id);
        const mergeBound = mergeOntologyCandidateAction.bind(null, c.id);
        return (
          <div key={c.id} style={CARD_STYLE}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>«{c.rawPhrase}»</div>
            <form action={mergeBound} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select name="nodeId" required style={{ flex: 1, padding: 8, borderRadius: 6, border: "1px solid #ddd", fontSize: 13 }}>
                <option value="">— выбрать узел онтологии —</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.nameRu} ({n.nodeType})
                  </option>
                ))}
              </select>
              <button type="submit" style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#27ae60", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                Merge
              </button>
            </form>
            <form action={rejectBound} style={{ marginTop: 8 }}>
              <button type="submit" style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#c0392b", fontSize: 12, cursor: "pointer" }}>
                Отклонить
              </button>
            </form>
          </div>
        );
      })}
    </div>
  );
}
