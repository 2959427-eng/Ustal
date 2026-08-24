"use client";

import { useFormState, useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "./actions";

const initialState: LoginState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ padding: "10px 16px", borderRadius: 8, border: "none", background: "#111", color: "#fff", fontSize: 14, cursor: pending ? "default" : "pointer" }}>
      {pending ? "Входим…" : "Войти"}
    </button>
  );
}

export default function LoginPage() {
  const [state, formAction] = useFormState(loginAction, initialState);

  return (
    <main style={{ maxWidth: 360, margin: "96px auto", padding: "0 24px" }}>
      <h1 style={{ fontSize: 20, marginBottom: 24 }}>USTAL — вход в админку</h1>
      <form action={formAction} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 13, color: "#444" }}>
          Email
          <input name="email" type="email" required autoComplete="username" style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13, color: "#444" }}>
          Пароль
          <input name="password" type="password" required autoComplete="current-password" style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }} />
        </label>
        {state.error ? <p style={{ color: "#c0392b", fontSize: 13, margin: 0 }}>{state.error}</p> : null}
        <SubmitButton />
      </form>
    </main>
  );
}
