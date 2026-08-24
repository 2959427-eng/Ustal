import Link from "next/link";
import { requireAdminSession } from "../../lib/session";
import { logoutAction } from "../login/actions";

const NAV = [
  { href: "/", label: "Обзор" },
  { href: "/users", label: "Пользователи" },
  { href: "/orders", label: "Заказы" },
  { href: "/moderation", label: "Модерация" },
  { href: "/ontology-candidates", label: "Ontology candidates" },
  { href: "/ai-costs", label: "Расход на AI" },
  { href: "/reports", label: "Жалобы и блокировки" },
];

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = requireAdminSession(); // редиректит на /login, если сессии нет

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav style={{ width: 220, background: "#111", color: "#fff", padding: "24px 16px", flexShrink: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 24 }}>USTAL Admin</div>
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 4 }}>
          {NAV.map((item) => (
            <li key={item.href}>
              <Link href={item.href} style={{ color: "#ccc", textDecoration: "none", display: "block", padding: "8px 10px", borderRadius: 6, fontSize: 14 }}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 32, fontSize: 12, color: "#888" }}>{session.email}</div>
        <form action={logoutAction}>
          <button type="submit" style={{ marginTop: 8, background: "none", border: "1px solid #444", color: "#ccc", borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}>
            Выйти
          </button>
        </form>
      </nav>
      <main style={{ flex: 1, padding: "32px 40px" }}>{children}</main>
    </div>
  );
}
