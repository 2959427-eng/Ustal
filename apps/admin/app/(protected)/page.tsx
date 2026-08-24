import { sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { eq } from "drizzle-orm";

async function loadStats() {
  const db = getDb();
  const [[users], [orders], [pendingModeration], [pendingOntology], [openReports]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(schema.users),
    db.select({ count: sql<number>`count(*)::int` }).from(schema.orders),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.orders)
      .where(eq(schema.orders.status, "moderation_hold")),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.ontologyCandidates)
      .where(eq(schema.ontologyCandidates.status, "pending")),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.reports)
      .where(eq(schema.reports.status, "open")),
  ]);
  return {
    users: users?.count ?? 0,
    orders: orders?.count ?? 0,
    pendingModeration: pendingModeration?.count ?? 0,
    pendingOntology: pendingOntology?.count ?? 0,
    openReports: openReports?.count ?? 0,
  };
}

const CARD_STYLE: React.CSSProperties = { background: "#fff", borderRadius: 10, padding: 20, minWidth: 160 };

export default async function DashboardPage() {
  const stats = await loadStats();

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Обзор</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>Живые цифры из БД, без отдельной BI-платформы (MVP).</p>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={CARD_STYLE}>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{stats.users}</div>
          <div style={{ color: "#666", fontSize: 13 }}>пользователей</div>
        </div>
        <div style={CARD_STYLE}>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{stats.orders}</div>
          <div style={{ color: "#666", fontSize: 13 }}>заказов всего</div>
        </div>
        <div style={{ ...CARD_STYLE, border: stats.pendingModeration > 0 ? "2px solid #e67e22" : undefined }}>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{stats.pendingModeration}</div>
          <div style={{ color: "#666", fontSize: 13 }}>заказов ждут модерации</div>
        </div>
        <div style={{ ...CARD_STYLE, border: stats.pendingOntology > 0 ? "2px solid #e67e22" : undefined }}>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{stats.pendingOntology}</div>
          <div style={{ color: "#666", fontSize: 13 }}>ontology candidates</div>
        </div>
        <div style={{ ...CARD_STYLE, border: stats.openReports > 0 ? "2px solid #e67e22" : undefined }}>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{stats.openReports}</div>
          <div style={{ color: "#666", fontSize: 13 }}>открытых жалоб</div>
        </div>
      </div>
    </div>
  );
}
