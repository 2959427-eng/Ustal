import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { resolveModerationAction } from "./actions";

const CARD_STYLE: React.CSSProperties = { background: "#fff", borderRadius: 10, padding: 20, marginBottom: 16 };

export default async function ModerationPage() {
  const db = getDb();
  const orders = await db.query.orders.findMany({
    where: eq(schema.orders.status, "moderation_hold"),
    orderBy: (t, { asc }) => asc(t.createdAt),
    limit: 50,
  });

  const casesByOrder = new Map<string, (typeof schema.moderationCases.$inferSelect)[]>();
  if (orders.length > 0) {
    const cases = await db.query.moderationCases.findMany({
      where: (t, { inArray }) => inArray(t.orderId, orders.map((o) => o.id)),
      orderBy: (t, { desc }) => desc(t.createdAt),
    });
    for (const c of cases) {
      if (!c.orderId) continue;
      const list = casesByOrder.get(c.orderId) ?? [];
      list.push(c);
      casesByOrder.set(c.orderId, list);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Модерация</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>
        Заказы в статусе moderation_hold — либо regulated (нет верификации в MVP, всегда сюда), либо жёсткое
        rule-правило, либо пограничное решение AI-модерации.
      </p>
      {orders.length === 0 ? <p style={{ color: "#999" }}>Очередь пуста.</p> : null}
      {orders.map((order) => {
        const history = casesByOrder.get(order.id) ?? [];
        const latest = history[0];
        const allowBound = resolveModerationAction.bind(null, order.id, "allow");
        const warnBound = resolveModerationAction.bind(null, order.id, "allow_with_warning");
        const rejectBound = resolveModerationAction.bind(null, order.id, "reject");
        return (
          <div key={order.id} style={CARD_STYLE}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{order.normalizedTitle ?? "(без названия)"}</div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>{order.normalizedDescription}</div>
            <div style={{ fontSize: 12, color: "#999", marginBottom: 12 }}>
              risk_level={order.riskLevel} · создан {new Date(order.createdAt).toLocaleString("ru-RU")}
            </div>
            {latest ? (
              <div style={{ fontSize: 12, background: "#f5f5f7", borderRadius: 6, padding: 8, marginBottom: 12 }}>
                Последнее решение: <strong>{latest.decision}</strong> — {latest.reason}
              </div>
            ) : null}
            <form action={allowBound} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <textarea
                name="note"
                placeholder="Комментарий (необязательно)"
                rows={2}
                style={{ flex: 1, padding: 8, borderRadius: 6, border: "1px solid #ddd", fontSize: 13 }}
              />
              <div style={{ display: "grid", gap: 6 }}>
                <button type="submit" style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#27ae60", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                  Разрешить
                </button>
                <button type="submit" formAction={warnBound} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#e67e22", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                  С предупреждением
                </button>
                <button type="submit" formAction={rejectBound} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#c0392b", color: "#fff", fontSize: 12, cursor: "pointer" }}>
                  Отклонить
                </button>
              </div>
            </form>
          </div>
        );
      })}
    </div>
  );
}
