import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { resolveReportAction } from "./actions";

const CARD_STYLE: React.CSSProperties = { background: "#fff", borderRadius: 10, padding: 16, marginBottom: 12 };
const TABLE_CELL: React.CSSProperties = { padding: "8px 12px", borderBottom: "1px solid #eee", fontSize: 13, textAlign: "left" };

export default async function ReportsPage() {
  const db = getDb();
  const [openReports, recentBlocks] = await Promise.all([
    db.query.reports.findMany({ where: eq(schema.reports.status, "open"), orderBy: (t, { asc }) => asc(t.createdAt), limit: 50 }),
    db.query.blocks.findMany({ orderBy: (t, { desc: d }) => d(t.createdAt), limit: 50 }),
  ]);

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Жалобы и блокировки</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>
        Жалобы — POST /reports (заказ/пользователь/отклик). Блокировки — POST /blocks (matching и подбор кандидатов
        учитывают обе стороны, docs/matching.md §13.1); список ниже — только для наблюдения, без действий (блокировка
        — решение самого пользователя, не модератора).
      </p>

      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Открытые жалобы ({openReports.length})</h2>
      {openReports.length === 0 ? <p style={{ color: "#999" }}>Очередь пуста.</p> : null}
      {openReports.map((r) => {
        const resolveBound = resolveReportAction.bind(null, r.id, "resolved");
        const dismissBound = resolveReportAction.bind(null, r.id, "dismissed");
        return (
          <div key={r.id} style={CARD_STYLE}>
            <div style={{ fontSize: 13, marginBottom: 4 }}>
              <strong>{r.targetType}</strong> · {r.targetId}
            </div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>Причина: {r.reason}</div>
            {r.comment ? <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>{r.comment}</div> : null}
            <div style={{ fontSize: 12, color: "#999", marginBottom: 12 }}>{new Date(r.createdAt).toLocaleString("ru-RU")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <form action={resolveBound}>
                <button type="submit" style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#27ae60", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                  Решено
                </button>
              </form>
              <form action={dismissBound}>
                <button type="submit" style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#666", fontSize: 12, cursor: "pointer" }}>
                  Отклонить жалобу
                </button>
              </form>
            </div>
          </div>
        );
      })}

      <h2 style={{ fontSize: 16, margin: "24px 0 12px" }}>Недавние блокировки ({recentBlocks.length})</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 8, overflow: "hidden" }}>
        <thead>
          <tr>
            <th style={TABLE_CELL}>blocker_id</th>
            <th style={TABLE_CELL}>blocked_id</th>
            <th style={TABLE_CELL}>Когда</th>
          </tr>
        </thead>
        <tbody>
          {recentBlocks.map((b) => (
            <tr key={b.id}>
              <td style={TABLE_CELL}>{b.blockerId}</td>
              <td style={TABLE_CELL}>{b.blockedId}</td>
              <td style={TABLE_CELL}>{new Date(b.createdAt).toLocaleString("ru-RU")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
