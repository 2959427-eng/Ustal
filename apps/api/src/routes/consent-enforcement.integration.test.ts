import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { assertLocalTestDatabase, getSql, disclosureHash, pauseConsentWork } from "@ustal/database";
import { buildApp } from "../app.js";
import { signAccessToken } from "../lib/auth-tokens.js";
assertLocalTestDatabase();const sql=getSql(),userId=randomUUID(),policyId=randomUUID(),purpose=`api-worker-${randomUUID()}`;
const content={humanText:"TEST ONLY local API fixture"},policyHash=disclosureHash(content);
beforeAll(async()=>{
 await sql`INSERT INTO users(id,phone,password_hash) VALUES(${userId},${`api_${userId.slice(0,15)}`},'fixture')`;
 await sql`INSERT INTO consent_disclosures(id,purpose,version,content,content_hash,status,is_current) VALUES(${policyId},${purpose},'fixture',${JSON.stringify(content)}::text::jsonb,${policyHash},'approved',true)`;
});
afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await sql`UPDATE users SET status='deleted' WHERE id=${userId}`;await sql.end();});
it("default/off keeps dormant endpoint unavailable",async()=>{
 vi.stubEnv("USTAL_AI_CONSENT_MODE","off");const app=await buildApp();
 try{expect((await app.inject({method:"GET",url:"/me/consents"})).statusCode).toBe(404);}finally{await app.close();}
});
it("enforced API authenticates, grants and atomically wakes paused worker work; revoke does not enqueue",async()=>{
 vi.stubEnv("USTAL_AI_CONSENT_MODE","enforced");vi.stubEnv("USTAL_AI_CONSENT_PURPOSE",purpose);const app=await buildApp();
 try{
  expect((await app.inject({method:"GET",url:"/me/consents"})).statusCode).toBe(401);
  const headers={authorization:`Bearer ${signAccessToken(userId)}`};
  const status=await app.inject({method:"GET",url:"/me/consents",headers});expect(status.statusCode).toBe(200);expect(status.json().outboundEnforcement).toBe(true);
  const paused=await pauseConsentWork({kind:"profile_extract",sourceId:randomUUID(),executionId:randomUUID(),sourceVersionHash:"a".repeat(64),subjectUserIds:[userId],purpose,policyId,policyHash,recipientBinding:"b".repeat(64)},"consent_required");
  await sql`UPDATE ai_consent_blocked_work SET state='waiting',next_probe_at=null WHERE id=${paused.id!}`;
  const grant=await app.inject({method:"POST",url:"/me/consents",headers,payload:{policyId,policyHash,decision:"grant",expectedRevision:0}});expect(grant.statusCode).toBe(200);
  const [row]=await sql`SELECT state FROM ai_consent_blocked_work WHERE id=${paused.id!}`;expect(row!.state).toBe("ready");
  const revoke=await app.inject({method:"POST",url:"/me/consents",headers,payload:{policyId,policyHash,decision:"revoke",expectedRevision:1}});expect(revoke.statusCode).toBe(200);
  expect(revoke.json().revision).toBe(2);
 }finally{await app.close();}
});
