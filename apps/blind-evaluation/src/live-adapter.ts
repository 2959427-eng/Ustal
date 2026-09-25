import { randomUUID } from "node:crypto";
import { configurePipeline, createRuntimePool, verifyRuntimeIsolation } from "./pipeline-environment.js";

export interface PipelineInput { caseId: string; profileText: string; orderText: string }
export interface PipelineResult { caseId: string; orderId: string; userId: string; matchingRunId: string | null }

// Existing handlers own extraction, normalization, embeddings, retrieval and scoring.
export async function createLiveAdapter(mode: "dry" | "offline-test" | "live") {
  configurePipeline(mode);
  const load = (path: string) => import(new URL(path, import.meta.url).href);
  const profile = await load("../../worker/src/handlers/profile-extraction.ts");
  const order = await load("../../worker/src/handlers/order-extraction.ts");
  const matching = await load("../../worker/src/handlers/matching-run.ts");
  const database = await load("../../../packages/database/src/index.ts");
  const domain = await load("../../../packages/domain/src/index.ts");
  if (![profile.handleProfileExtraction, order.handleOrderExtraction, matching.handleMatchingRun].every(fn => typeof fn === "function")) throw new Error("Real pipeline exports missing");
  const pool = createRuntimePool();
  try { await verifyRuntimeIsolation(pool); } catch (error) { await pool.end(); throw error; }
  const identity = await database.getSql()`select current_database() as db, current_user as role`;
  const expected = await pool.query("SELECT current_database() AS db, current_user AS role");
  if (identity[0].db !== expected.rows[0].db || identity[0].role !== expected.rows[0].role) {
    await pool.end(); await database.getSql().end(); throw new Error("Worker connection identity mismatch");
  }
  const job = (data: object) => ({ id: randomUUID(), data });
  async function createUser(cityId: string) {
    const result = await pool.query("INSERT INTO users(phone,password_hash,status) VALUES($1,'blind-test-only','active') RETURNING id", [randomUUID().slice(0,20)]);
    const id = result.rows[0].id as string;
    await pool.query("INSERT INTO user_profiles(user_id,name,city_id,accepted_rules_at,accepted_pdn_at) VALUES($1,'Blind evaluation',$2,now(),now())", [id,cityId]);
    return id;
  }
  return {
    pool,
    async run(input: PipelineInput): Promise<PipelineResult> {
      if (mode === "dry") throw new Error("Pipeline execution forbidden in dry-run");
      if (!input.profileText.trim() || !input.orderText.trim()) throw new Error("Empty pipeline input");
      const city = await pool.query("INSERT INTO cities(name,region_name,federal_district,timezone,is_active) VALUES($1,'TEST','TEST','Asia/Vladivostok',false) RETURNING id", [`Blind ${randomUUID()}`]);
      const cityId = city.rows[0].id;
      const userId = await createUser(cityId), authorId = await createUser(cityId);
      const source = await pool.query("INSERT INTO profile_source_inputs(user_id,input_type,raw_text,status) VALUES($1,'text',$2,'confirmed') RETURNING id", [userId,input.profileText]);
      const extracted = await profile.handleProfileExtraction(job({userId,sourceInputId:source.rows[0].id}));
      const applied = await pool.query("UPDATE capability_profiles SET status='applied' WHERE id=$1 AND user_id=$2 AND status='draft' RETURNING id", [extracted.profileId,userId]);
      if (applied.rowCount !== 1) throw new Error("Profile extraction did not produce an applicable draft");
      const created = await pool.query("INSERT INTO orders(author_id,city_id,source_text,source_status,status) VALUES($1,$2,$3,'confirmed','processing') RETURNING id", [authorId,cityId,input.orderText]);
      const orderId = created.rows[0].id as string;
      await order.handleOrderExtraction(job({orderId}));
      const stored = await pool.query("SELECT status, moderation_status FROM orders WHERE id=$1", [orderId]);
      if (!["allow","allow_with_warning"].includes(stored.rows[0].moderation_status)) {
        if (!["reject", "manual_review"].includes(stored.rows[0].moderation_status)) throw new Error("Order extraction incomplete");
        return {caseId: input.caseId, orderId, userId, matchingRunId:null};
      }
      domain.assertOrderTransition(stored.rows[0].status, "published");
      await pool.query("UPDATE orders SET status='published', published_at=now() WHERE id=$1", [orderId]);
      const result = await matching.handleMatchingRun(job({orderId}));
      if (!result.matchingRunId || result.skipped) throw new Error("Matching did not complete");
      return {caseId:input.caseId, orderId, userId, matchingRunId:result.matchingRunId};
    },
    async close() { await pool.end(); await database.getSql().end(); },
  };
}
