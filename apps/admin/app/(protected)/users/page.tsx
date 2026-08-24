import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { setUserStatusAction } from "./actions";

const TABLE_CELL: React.CSSProperties = { padding: "8px 12px", borderBottom: "1px solid #eee", fontSize: 13, textAlign: "left" };

export default async function UsersPage() {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.users.id,
      phone: schema.users.phone,
      status: schema.users.status,
      verificationLevel: schema.users.verificationLevel,
      createdAt: schema.users.createdAt,
      name: schema.userProfiles.name,
      cityName: schema.cities.name,
    })
    .from(schema.users)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
    .leftJoin(schema.cities, eq(schema.cities.id, schema.userProfiles.cityId))
    .orderBy(desc(schema.users.createdAt))
    .limit(100);

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Пользователи</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>Последние 100 (по дате регистрации). Одна учётная запись — обе роли (заказчик/исполнитель определяются действием, не выбором).</p>
      <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 8, overflow: "hidden" }}>
        <thead>
          <tr>
            <th style={TABLE_CELL}>Имя</th>
            <th style={TABLE_CELL}>Телефон</th>
            <th style={TABLE_CELL}>Город</th>
            <th style={TABLE_CELL}>Статус</th>
            <th style={TABLE_CELL}>Верификация</th>
            <th style={TABLE_CELL}>Регистрация</th>
            <th style={TABLE_CELL}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td style={TABLE_CELL}>{u.name ?? "—"}</td>
              <td style={TABLE_CELL}>{u.phone}</td>
              <td style={TABLE_CELL}>{u.cityName ?? "—"}</td>
              <td style={TABLE_CELL}>
                <span style={{ color: u.status === "active" ? "#27ae60" : "#c0392b" }}>{u.status}</span>
              </td>
              <td style={TABLE_CELL}>{u.verificationLevel}</td>
              <td style={TABLE_CELL}>{new Date(u.createdAt).toLocaleString("ru-RU")}</td>
              <td style={TABLE_CELL}>
                <form action={setUserStatusAction.bind(null, u.id, u.status === "active" ? "blocked" : "active")}>
                  <button
                    type="submit"
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid #ddd",
                      background: u.status === "active" ? "#fdecea" : "#eafaf1",
                      color: u.status === "active" ? "#c0392b" : "#27ae60",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {u.status === "active" ? "Заблокировать" : "Разблокировать"}
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
