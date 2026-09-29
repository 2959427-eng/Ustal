/** Frozen blind holdout-100 through the same real functions as probe.ts (A/B harness, not the official DB harness). */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildProfile, buildOrder, match, pool } from "./lib.js";
const path = process.env.HOLDOUT ?? "holdout.json";
const bytes = readFileSync(path);
if (createHash("sha256").update(bytes).digest("hex") !== "53b5c42387ff4ba29fcafa7debfe89b8faae2255e54d8c3dd057cb9fa7975bd3") throw new Error("SHA mismatch");
const cases = JSON.parse(bytes.toString("utf8")).cases as any[];
const inputText = (v: any) => typeof v === "string" ? v : (Object.keys(v).length === 1 && typeof v.text === "string" ? v.text : JSON.stringify(v));
const [from, to, out] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]!];
const done = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const todo = cases.slice(from, to).filter((c) => !done[c.case_id] || done[c.case_id].error);
await pool(todo.map((c) => async () => {
  try {
    // label sealed: expected_label is not read until the summary step
    const [p, o] = await Promise.all([buildProfile(c.case_id, inputText(c.profile_text ?? c.profile)), buildOrder(c.case_id, inputText(c.order_text ?? c.order))]);
    const r = ["manual_review", "reject"].includes(o.moderation!) ? { decision: "REJECT", reason: "moderation_" + o.moderation } : await match(p, o);
    done[c.case_id] = r;
  } catch (e) { done[c.case_id] = { error: String(e).slice(0, 300) }; }
  writeFileSync(out, JSON.stringify(done, null, 1));
}), 2);
writeFileSync(out, JSON.stringify(done, null, 1));
console.log("done", Object.keys(done).length);
