import { desc } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";

const TABLE_CELL: React.CSSProperties = { padding: "8px 12px", borderBottom: "1px solid #eee", fontSize: 13, textAlign: "left" };

const STATUS_COLOR: Record<string, string> = {
  published: "#27ae60",
  negotiating: "#2980b9",
  closed: "#7f8c8d",
  moderation_hold: "#e67e22",
  cancelled: "#c0392b",
  rejected: "#c0392b",
  expired: "#7f8c8d",
  processing: "#8e44ad",
  draft: "#95a5a6",
};

export default async function OrdersPage() {
  const db = getDb();
  const rows = await db.query.orders.findMany({
    orderBy: (t, { desc: d }) => d(t.createdAt),
    limit: 100,
  });

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Заказы</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>Последние 100. Решения по заказам, требующим модерации — в разделе «Модерация».</p>
      <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 8, overflow: "hidden" }}>
        <thead>
          <tr>
            <th style={TABLE_CELL}>Заголовок</th>
            <th style={TABLE_CELL}>Статус</th>
            <th style={TABLE_CELL}>Модерация</th>
            <th style={TABLE_CELL}>Риск</th>
            <th style={TABLE_CELL}>Создан</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td style={TABLE_CELL}>{o.normalizedTitle ?? <span style={{ color: "#999" }}>(без названия)</span>}</td>
              <td style={TABLE_CELL}>
                <span style={{ color: STATUS_COLOR[o.status] ?? "#333" }}>{o.status}</span>
              </td>
              <td style={TABLE_CELL}>{o.moderationStatus}</td>
              <td style={TABLE_CELL}>{o.riskLevel}</td>
              <td style={TABLE_CELL}>{new Date(o.createdAt).toLocaleString("ru-RU")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
