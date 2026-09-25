import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
export const datasetPath = () => process.env.HOLDOUT_DATA_PATH || fileURLToPath(new URL("../../../docs/evaluations/semantic-blind-holdout-100.json",import.meta.url));
type RecordValue = Record<string, unknown>;
const nonempty=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
export function inputText(value: unknown): string | undefined {
  if(nonempty(value))return value;
  if(value && typeof value==="object" && !Array.isArray(value) && Object.keys(value).length) {
    const fields=value as RecordValue;
    if(Object.keys(fields).length===1 && nonempty(fields.text)) return fields.text;
    return JSON.stringify(value); // Preserve every supplied structured input field.
  }
}
export function loadHoldoutDataset(path=datasetPath()) {
  const bytes=readFileSync(path);
  const digest=createHash("sha256").update(bytes).digest("hex");
  if(digest!=="53b5c42387ff4ba29fcafa7debfe89b8faae2255e54d8c3dd057cb9fa7975bd3")throw new Error("Frozen dataset SHA256 mismatch");
  const data=JSON.parse(bytes.toString("utf8")) as {cases:RecordValue[]};
  if(!Array.isArray(data.cases)||data.cases.length!==100)throw new Error("Frozen holdout must contain exactly 100 cases");
  const ids=new Set<string>();
  const cases=data.cases.map(c=>{
    const id=c.case_id ?? c.id, label=c.expected_label;
    const profileText=inputText(c.profile_text ?? c.profile);
    const orderText=inputText(c.order_text ?? c.order);
    if(!nonempty(id)||ids.has(id)||!profileText||!orderText||!["MATCH","REJECT"].includes(String(label)))
      throw new Error("Dataset contract invalid: unique id, profile text, order text and binary label required");
    ids.add(id);
    return {id,skill:nonempty(c.skill)?c.skill:"",profileText,orderText,label:label as "MATCH"|"REJECT"};
  });
  return {sha256:createHash("sha256").update(bytes).digest("hex"),cases};
}
export async function injectHoldoutCases(pool:Pool,dataset:ReturnType<typeof loadHoldoutDataset>) {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const existing=await client.query("SELECT sha256 FROM blind_evaluation.dataset_manifest");
    if(existing.rowCount && existing.rows[0].sha256!==dataset.sha256)throw new Error("Refusing to replace a different frozen dataset");
    for(const c of dataset.cases) {
      const row=await client.query("SELECT skill,order_description,profile_json,order_json,expected_label FROM blind_evaluation.holdout_cases WHERE case_id=$1",[c.id]);
      const profile={text:c.profileText},order={text:c.orderText};
      if(row.rowCount) {
        const stored=row.rows[0];
        if(stored.skill!==c.skill||stored.order_description!==c.orderText||stored.profile_json.text!==c.profileText||stored.order_json.text!==c.orderText||stored.expected_label!==c.label)
          throw new Error("Existing holdout differs from immutable source");
      } else {
        await client.query("INSERT INTO blind_evaluation.holdout_cases(case_id,skill,order_description,profile_json,order_json,expected_label,sealed) VALUES($1,$2,$3,$4,$5,$6,true)",
          [c.id,c.skill,c.orderText,JSON.stringify(profile),JSON.stringify(order),c.label]);
      }
    }
    const count=await client.query("SELECT count(*)::int AS n FROM blind_evaluation.holdout_cases");
    if(count.rows[0].n!==100)throw new Error("Unexpected extra or missing holdout cases");
    await client.query("INSERT INTO blind_evaluation.dataset_manifest(singleton,sha256,case_count) VALUES(true,$1,100) ON CONFLICT(singleton) DO NOTHING",[dataset.sha256]);
    await client.query("COMMIT");
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}

