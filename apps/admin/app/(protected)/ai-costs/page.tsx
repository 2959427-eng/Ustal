import { sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";

const TABLE_CELL: React.CSSProperties = { padding: "8px 12px", borderBottom: "1px solid #eee", fontSize: 13, textAlign: "left" };

interface CostRow {
  [key: string]: unknown;
  operation_type: string;
  provider: string;
  calls: number;
  tokens_input: number;
  tokens_output: number;
  estimated_cost_minor: number;
  errors: number;
}

export default async function AiCostsPage() {
  const db = getDb();
  const rows = await db.execute<CostRow>(sql`
    SELECT
      operation_type,
      provider,
      count(*)::int AS calls,
      coalesce(sum(tokens_input), 0)::int AS tokens_input,
      coalesce(sum(tokens_output), 0)::int AS tokens_output,
      coalesce(sum(estimated_cost_minor), 0)::int AS estimated_cost_minor,
      count(*) FILTER (WHERE status = 'error')::int AS errors
    FROM ai_runs
    WHERE started_at > now() - interval '30 days'
    GROUP BY operation_type, provider
    ORDER BY operation_type, provider
  `);
  const items = [...rows];
  const totalCostMinor = items.reduce((sum, r) => sum + r.estimated_cost_minor, 0);

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Расход на AI</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>
        Агрегация ai_runs за последние 30 дней по типу операции и провайдеру (docs/api.md /admin/ai-costs) — без
        отдельной BI-платформы. estimated_cost_minor пока не считается для OpenAI-провайдера (заготовка, см.
        packages/ai/src/record-run.ts) — на MockAIProvider всегда 0, это ожидаемо в разработке.
      </p>
      <div style={{ marginBottom: 16, fontSize: 14 }}>
        Итого за 30 дней: <strong>{(totalCostMinor / 100).toFixed(2)} ₽</strong>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 8, overflow: "hidden" }}>
        <thead>
          <tr>
            <th style={TABLE_CELL}>Операция</th>
            <th style={TABLE_CELL}>Провайдер</th>
            <th style={TABLE_CELL}>Вызовов</th>
            <th style={TABLE_CELL}>Ошибок</th>
            <th style={TABLE_CELL}>Токены (in/out)</th>
            <th style={TABLE_CELL}>Стоимость</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={`${r.operation_type}-${r.provider}`}>
              <td style={TABLE_CELL}>{r.operation_type}</td>
              <td style={TABLE_CELL}>{r.provider}</td>
              <td style={TABLE_CELL}>{r.calls}</td>
              <td style={TABLE_CELL}>{r.errors > 0 ? <span style={{ color: "#c0392b" }}>{r.errors}</span> : 0}</td>
              <td style={TABLE_CELL}>
                {r.tokens_input} / {r.tokens_output}
              </td>
              <td style={TABLE_CELL}>{(r.estimated_cost_minor / 100).toFixed(2)} ₽</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
