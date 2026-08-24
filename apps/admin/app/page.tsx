const SECTIONS = [
  { href: "/users", label: "Пользователи" },
  { href: "/orders", label: "Заказы" },
  { href: "/moderation", label: "Модерация" },
  { href: "/ontology-candidates", label: "Ontology candidates" },
  { href: "/ai-costs", label: "Расход на AI" },
  { href: "/reports", label: "Жалобы и блокировки" },
];

export default function DashboardPage() {
  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: "0 24px" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>USTAL — админка</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>
        Раздел авторизации (POST /admin session) и защищённый layout — Фаза 8.
        Ниже — карта разделов, которые появятся по мере готовности бэкенда.
      </p>
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
        {SECTIONS.map((s) => (
          <li key={s.href} style={{ padding: 12, background: "#fff", borderRadius: 8 }}>
            {s.label}
          </li>
        ))}
      </ul>
    </main>
  );
}
