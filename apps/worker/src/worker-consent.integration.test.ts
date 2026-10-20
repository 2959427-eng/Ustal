import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMatchingRun } from "./handlers/matching-run.js";
import { writeFile } from "node:fs/promises";
import { handleProfileTranscribe } from "./handlers/profile-transcribe.js";
import { handleProfileFactsExtraction } from "./handlers/profile-facts-extraction.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertLocalTestDatabase, getDb, getSql, schema, disclosureHash, decideConsent, closeConsentAuthorizationPool } from "@ustal/database";
import { currentOpenAiRecipientConfiguration, openAiProviders, AiConsentDenied } from "@ustal/ai";
import { assertConsentResultCommit, resolveConsentSource, bootstrapWorkerConsent, consentJob, consentPair, dispatchConsentWork, consentRunReusable } from "./worker-consent.js";
import { withRecoveryTracking } from "./profile-input-recovery.js";
vi.mock("@ustal/storage",()=>({getMediaStorage:()=>({resolvePath:async()=>process.env.USTAL_TEST_AUDIO_PATH!})}));
assertLocalTestDatabase();
const sql=getSql();
const createdUsers:string[]=[];
const purpose=`worker-${randomUUID()}`;
let policyId=randomUUID(), policyHash="";
const transport=vi.fn(async () => new Response(JSON.stringify({ data:[{index:0,embedding:[1,0]}], usage:{prompt_tokens:1,total_tokens:1}, model:"fixture" }), {headers:{"content-type":"application/json"}}));
beforeAll(async()=>{
  vi.stubEnv("AI_PROVIDER","openai");
  vi.stubEnv("OPENAI_API_KEY","synthetic-local-key");
  vi.stubEnv("OPENAI_BASE_URL","http://127.0.0.1:9/v1");
  vi.stubGlobal("fetch",transport);
  const actual=await currentOpenAiRecipientConfiguration();
  const content={humanText:"TEST ONLY synthetic local permission; not an actual legal approval",aiDispatch:{schemaVersion:1,purpose,recipients:[{name:"TEST ONLY loopback transport",...actual}]}};
  policyHash=disclosureHash(content);
  await sql`INSERT INTO consent_disclosures(id,purpose,version,content,content_hash,status,is_current) VALUES(${policyId},${purpose},'fixture-1',${JSON.stringify(content)}::text::jsonb,${policyHash},'approved',true)`;
  await bootstrapWorkerConsent({mode:"enforced",purpose});
});
afterAll(async()=>{
 vi.unstubAllGlobals();vi.unstubAllEnvs();
 if(createdUsers.length){
  await sql`UPDATE profile_source_inputs SET revoked_at=now() WHERE user_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(createdUsers)}::text::jsonb))`;
  await sql`UPDATE users SET status='deleted' WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(createdUsers)}::text::jsonb))`;
 }
 await closeConsentAuthorizationPool();await sql.end();
});
async function fixture(granted=false){
 const userId=randomUUID(),sourceInputId=randomUUID();createdUsers.push(userId);
 await sql`INSERT INTO users(id,phone,password_hash) VALUES(${userId},${`w_${userId.slice(0,15)}`},'fixture')`;
 await sql`INSERT INTO profile_source_inputs(id,user_id,input_type,status,raw_text) VALUES(${sourceInputId},${userId},'text','confirmed','synthetic skill')`;
 if(granted) await decideConsent(userId,{policyId,policyHash,decision:"grant",expectedRevision:0});
 return {userId,sourceInputId};
}
async function decision(userId:string,kind:"grant"|"revoke"){
 const [r]=await sql`SELECT coalesce(max(seq),0)::int revision FROM consent_decisions WHERE user_id=${userId}`;
 return decideConsent(userId,{policyId,policyHash,decision:kind,expectedRevision:r!.revision});
}
const job=(data:Awaited<ReturnType<typeof fixture>>,id=randomUUID())=>({id,data});
const embed=()=>openAiProviders.embedding.embed(["synthetic"],{operationType:"consent_fixture",traceId:randomUUID(),promptVersion:"fixture",schemaVersion:"fixture"});
describe.sequential("actual worker consent lifecycle, synthetic local transport",()=>{
 it("source fingerprint survives postgres-to-Drizzle timestamp parser initialization",async()=>{
  const f=await fixture();const before=await resolveConsentSource("profile_extract",f);getDb();
  const after=await resolveConsentSource("profile_extract",f);expect(after!.versionHash).toBe(before!.versionHash);
 });
 it("missing consent pauses durably; retry of same queued job never calls AI or duplicates pause",async()=>{
  const f=await fixture(),j=job(f),run=consentJob("profile_extract",embed),before=transport.mock.calls.length;
  expect(await run(j)).toEqual({paused:"consent"});expect(await run(j)).toEqual({paused:"consent"});
  expect(transport.mock.calls.length).toBe(before);
  const rows=await sql`SELECT * FROM ai_consent_blocked_work WHERE execution_id=${j.id}`;expect(rows).toHaveLength(1);
 });
 it("queued before revoke, executed after revoke: no outbound request",async()=>{
  const f=await fixture(true),j=job(f);await decision(f.userId,"revoke");const before=transport.mock.calls.length;
  expect(await consentJob("profile_extract",embed)(j)).toEqual({paused:"consent"});expect(transport.mock.calls.length).toBe(before);
 });
 it("valid consent admits actual SDK request and transactional result fence",async()=>{
  const f=await fixture(true),before=transport.mock.calls.length;
  await consentJob("profile_extract",async()=>{await embed();await getDb().transaction(tx=>assertConsentResultCommit(tx));})(job(f));
  expect(transport.mock.calls.length).toBe(before+1);
 });
 it("revoke after request admission rejects result commit and subsequent transport; no profile/facts resurrection",async()=>{
  const f=await fixture(true),before=transport.mock.calls.length;
  const result=await consentJob("profile_extract",async()=>{
   await embed();await decision(f.userId,"revoke");
   await expect(embed()).rejects.toBeInstanceOf(AiConsentDenied);
   await getDb().transaction(async tx=>{await assertConsentResultCommit(tx);throw Error("unreachable derived write");});
  })(job(f));
  expect(result).toEqual({paused:"consent"});expect(transport.mock.calls.length).toBe(before+1);
  expect(await sql`SELECT id FROM capability_profiles WHERE user_id=${f.userId}`).toHaveLength(0);
  expect(await sql`SELECT id FROM profile_facts WHERE user_id=${f.userId}`).toHaveLength(0);
 });
 it("concurrent revoke while SDK request is in flight discards its result",async()=>{
  const f=await fixture(true);let admitted!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>admitted=r),gate=new Promise<void>(r=>release=r);
  transport.mockImplementationOnce(async()=>{admitted();await gate;return new Response(JSON.stringify({data:[{index:0,embedding:[1,0]}],usage:{prompt_tokens:1,total_tokens:1},model:"fixture"}),{headers:{"content-type":"application/json"}});});
  const pending=consentJob("profile_extract",async()=>{await embed();await getDb().transaction(tx=>assertConsentResultCommit(tx));})(job(f));
  await started;await decision(f.userId,"revoke");release();
  expect(await pending).toEqual({paused:"consent"});
 });
 it("revoke then regrant cannot authorize an old in-flight result; fresh execution can resume",async()=>{
  const f=await fixture(true);
  expect(await consentJob("profile_extract",async()=>{await embed();await decision(f.userId,"revoke");await decision(f.userId,"grant");await getDb().transaction(tx=>assertConsentResultCommit(tx));})(job(f))).toEqual({paused:"consent"});
  await consentJob("profile_extract",embed)(job(f));
 });
 it("policy denial does not consume recovery failure budget",async()=>{
  const f=await fixture(true);
  await consentJob("profile_extract",async()=>withRecoveryTracking("extraction",{id:f.sourceInputId,userId:f.userId},async()=>{
    await decision(f.userId,"revoke");await embed();
  }))(job(f));
  const [r]=await sql`SELECT failed_attempts,lease_owner FROM profile_input_recovery WHERE source_input_id=${f.sourceInputId}`;
  expect(r!.failed_attempts).toBe(0);expect(r!.lease_owner).toBeNull();
 });
 it("grant wakes durable pause; restarted dispatcher reconstructs fresh job without source text; revoked source never resumes",async()=>{
  const f=await fixture(),j=job(f);await consentJob("profile_extract",embed)(j);
  await dispatchConsentWork(async(_kind,data)=>{expect(data.sourceInputId).not.toBe(f.sourceInputId);return randomUUID();});
  await decision(f.userId,"grant");const enqueued:any[]=[];
  await dispatchConsentWork(async(kind,data,key)=>{enqueued.push({kind,data,key});return randomUUID();});
  expect(enqueued.some(x=>x.data.sourceInputId===f.sourceInputId)).toBe(true);
  const found=enqueued.find(x=>x.data.sourceInputId===f.sourceInputId);expect(found.data).toEqual(f);
  const gone=await fixture();await consentJob("profile_extract",embed)(job(gone));await sql`UPDATE profile_source_inputs SET revoked_at=now() WHERE id=${gone.sourceInputId}`;
  await dispatchConsentWork(async(_kind,data)=>{expect(data.sourceInputId).not.toBe(gone.sourceInputId);return randomUUID();});
 });
 it("denied pair neither poisons a granted pair nor makes whole-run reusable",async()=>{
  const author=await fixture(true),denied=await fixture(),allowed=await fixture(true);
  await consentJob("profile_extract",async()=>{
   expect(await consentPair(denied.userId,embed)).toEqual({allowed:false});
   expect((await consentPair(allowed.userId,embed)).allowed).toBe(true);
   expect(consentRunReusable()).toBe(false);
  })(job(author));
 });
 it("actual profile STT handler cannot persist transcript after concurrent revoke",async()=>{
  const f=await fixture(true),mediaId=randomUUID();
  const audioPath=join(tmpdir(),`ustal-consent-${randomUUID()}.wav`);
  await writeFile(audioPath,Buffer.from("synthetic local test audio"));vi.stubEnv("USTAL_TEST_AUDIO_PATH",audioPath);
  await sql`INSERT INTO media(id,owner_id,kind,storage_provider,storage_key,mime_type,size_bytes) VALUES(${mediaId},${f.userId},'audio','local','fixture','audio/wav',25)`;
  await sql`UPDATE profile_source_inputs SET input_type='voice',status='transcribing',audio_media_id=${mediaId} WHERE id=${f.sourceInputId}`;
  let started!:()=>void,release!:()=>void;const admitted=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
  transport.mockImplementationOnce(async()=>{started();await gate;return new Response(JSON.stringify({text:"synthetic transcript"}),{headers:{"content-type":"application/json"}});});
  const pending=consentJob("profile_transcribe",handleProfileTranscribe)(job(f) as any);
  await Promise.race([admitted,pending.then(value=>{throw Error(`STT ended before transport: ${JSON.stringify(value)}`);})]);await decision(f.userId,"revoke");release();expect(await pending).toEqual({paused:"consent"});
  const [row]=await sql`SELECT status,transcript FROM profile_source_inputs WHERE id=${f.sourceInputId}`;
  expect(row!.status).toBe("transcribing");expect(row!.transcript).toBeNull();
 });
 it("actual facts handler propagates typed policy denial rather than recording technical failure",async()=>{
  const f=await fixture(true);
  const spy=vi.spyOn(openAiProviders.extraction,"extractProfileFacts").mockImplementationOnce(async()=>{await decision(f.userId,"revoke");throw new AiConsentDenied("consent_required","not_granted");});
  try {expect(await consentJob("profile_facts",handleProfileFactsExtraction)(job(f) as any)).toEqual({paused:"consent"});}
  finally {spy.mockRestore();}
  const [row]=await sql`SELECT status,error FROM profile_fact_extractions WHERE source_input_id=${f.sourceInputId}`;
  expect(row!.status).toBe("pending");expect(row!.error).toBeNull();
  expect(await sql`SELECT id FROM profile_facts WHERE source_input_id=${f.sourceInputId}`).toHaveLength(0);
 });
 it("two actual matching jobs sharing a candidate complete without consent lock upgrades",async()=>{
  const authors=[await fixture(true),await fixture(true)],executor=await fixture(true),db=getDb();
  const [city]=await db.insert(schema.cities).values({name:`TEST_consent_${randomUUID()}`,regionName:"TEST",federalDistrict:"TEST",timezone:"Asia/Vladivostok",isActive:false}).returning();
  for(const u of [...authors,executor]) await db.insert(schema.userProfiles).values({userId:u.userId,cityId:city!.id,name:"TEST",acceptedRulesAt:new Date(),acceptedPdnAt:new Date()});
  const [node]=await sql`SELECT id FROM ontology_nodes WHERE canonical_key='physical_work' LIMIT 1`;
  const nodeId=node?.id ?? (await sql`SELECT id FROM ontology_nodes WHERE node_type='capability' LIMIT 1`)[0]!.id;
  const [profile]=await db.insert(schema.capabilityProfiles).values({userId:executor.userId,summary:"synthetic capability",profileVersion:1,extractionVersion:"fixture",status:"applied"}).returning();
  await db.insert(schema.userCapabilities).values({capabilityProfileId:profile!.id,ontologyNodeId:nodeId,label:`synthetic capability ${executor.userId}`,proficiency:"basic",evidenceType:"explicit",confidence:"0.9"});
  const orders=[];
  for(const author of authors){const [o]=await db.insert(schema.orders).values({authorId:author.userId,cityId:city!.id,sourceText:`synthetic task ${executor.userId}`,status:"published",riskLevel:1}).returning();orders.push(o!);await db.insert(schema.orderRequirements).values({orderId:o!.id,ontologyNodeId:nodeId,requirementType:"required_capability",isMandatory:true});}
  const spy=vi.spyOn(openAiProviders.extraction,"reviewSemantic").mockResolvedValue({data:{compatible:true,confidence:0.95,reason:"TEST ONLY review pass"},provider:"fixture",model:"fixture",tokensInput:0,tokensOutput:0,latencyMs:0});
  try{
   const outcomes=await Promise.all(orders.map(o=>consentJob("matching_run",handleMatchingRun)({id:randomUUID(),data:{orderId:o.id}} as any)));
   expect(outcomes.every(o=>!("paused" in o))).toBe(true);
   expect(spy.mock.calls.length).toBeGreaterThan(0);
   const rows=await sql`SELECT mc.user_id FROM matching_candidates mc JOIN matching_runs r ON r.id=mc.matching_run_id WHERE r.order_id IN (${orders[0]!.id},${orders[1]!.id})`;
   expect(rows.filter(r=>r.user_id===executor.userId)).toHaveLength(2);
   await decision(executor.userId,"revoke");
   const before=spy.mock.calls.length;
   const denied=await consentJob("matching_run",handleMatchingRun)({id:randomUUID(),data:{orderId:orders[0]!.id}} as any);
   expect("candidatesCount" in denied && denied.candidatesCount).toBe(0);
   expect(spy.mock.calls.length).toBe(before);
   // Exact delete-account lock order: author first, then its order. The job already holds an order FK lock.
   await decision(executor.userId,"grant");
   const [raceOrder]=await db.insert(schema.orders).values({authorId:authors[0]!.userId,cityId:city!.id,sourceText:`deletion race ${randomUUID()}`,status:"published",riskLevel:1}).returning();
   await db.insert(schema.orderRequirements).values({orderId:raceOrder!.id,ontologyNodeId:nodeId,requirementType:"required_capability",isMandatory:true});
   const [raceDoc]=await db.insert(schema.matchingDocuments).values({orderId:raceOrder!.id,processingVersion:"fixture",sourceHash:"a".repeat(64),sourceText:raceOrder!.sourceText!,embeddingModel:"fixture"}).returning();
   await db.insert(schema.matchingFacts).values({documentId:raceDoc!.id,kind:"capability",phrase:"synthetic",evidence:raceOrder!.sourceText!,nodeIds:[nodeId],confidence:"0.9",mandatory:true});
   let admitted!:()=>void,release!:()=>void,locked!:()=>void;
   const started=new Promise<void>(r=>admitted=r),gate=new Promise<void>(r=>release=r),userLocked=new Promise<void>(r=>locked=r);
   spy.mockImplementationOnce(async()=>{admitted();await gate;throw new AiConsentDenied("consent_required","not_granted");});
   const work=consentJob("matching_run",handleMatchingRun)({id:randomUUID(),data:{orderId:raceOrder!.id}} as any);
   await Promise.race([started,work.then(()=>{throw Error("expected review race barrier");})]);
   const deletion=sql.begin(async tx=>{
    await tx`SET LOCAL lock_timeout='3s'`;
    await tx`SELECT id FROM users WHERE id=${authors[0]!.userId} FOR UPDATE`;locked();
    await tx`SELECT id FROM orders WHERE id=${raceOrder!.id} FOR UPDATE`;
    await tx`UPDATE orders SET status='cancelled' WHERE id=${raceOrder!.id}`;
    await tx`UPDATE users SET status='deleted' WHERE id=${authors[0]!.userId}`;
   });
   await userLocked;release();
   const [finished]=await Promise.all([work,deletion]);expect("candidatesCount" in finished && finished.candidatesCount).toBe(0);
   const [closed]=await sql`SELECT status FROM orders WHERE id=${raceOrder!.id}`;expect(closed!.status).toBe("cancelled");
  }finally{spy.mockRestore();}
 },15000);
 it("registry lock/outage pauses within bounded time without an AI call",async()=>{
  const f=await fixture(true),held=await sql.reserve(),before=transport.mock.calls.length;
  await held`BEGIN`;await held`LOCK TABLE consent_disclosures IN ACCESS EXCLUSIVE MODE`;
  const start=Date.now();
  try {expect(await consentJob("profile_extract",embed)(job(f))).toEqual({paused:"consent"});}
  finally{await held`ROLLBACK`;held.release();}
  expect(Date.now()-start).toBeLessThan(4500);expect(transport.mock.calls.length).toBe(before);
  const [row]=await sql`SELECT reason FROM ai_consent_blocked_work WHERE source_id=${f.sourceInputId}`;
  expect(row!.reason).toBe("policy_unavailable");
 },10000);
 it("a changed model/recipient identity cannot use old consent",async()=>{
  const f=await fixture(true),before=transport.mock.calls.length,prior=process.env.AI_MODEL_EXTRACTION;
  vi.stubEnv("AI_MODEL_EXTRACTION","synthetic-other-model");
  try{expect(await consentJob("profile_extract",embed)(job(f))).toEqual({paused:"consent"});}
  finally{if(prior===undefined)delete process.env.AI_MODEL_EXTRACTION;else process.env.AI_MODEL_EXTRACTION=prior;}
  expect(transport.mock.calls.length).toBe(before);
 });
 it("new current publication rejects old consent; new grant resumes against the current version",async()=>{
  const f=await fixture(true),old=policyId;
  const actual=await currentOpenAiRecipientConfiguration();const content={humanText:"TEST ONLY replacement synthetic disclosure",aiDispatch:{schemaVersion:1,purpose,recipients:[{name:"TEST ONLY recipient",...actual}]}};
  policyId=randomUUID();policyHash=disclosureHash(content);
  await sql`UPDATE consent_disclosures SET is_current=false WHERE id=${old}`;
  await sql`INSERT INTO consent_disclosures(id,purpose,version,content,content_hash,status,is_current) VALUES(${policyId},${purpose},'fixture-2',${JSON.stringify(content)}::text::jsonb,${policyHash},'approved',true)`;
  const before=transport.mock.calls.length;expect(await consentJob("profile_extract",embed)(job(f))).toEqual({paused:"consent"});expect(transport.mock.calls.length).toBe(before);
  await decision(f.userId,"grant");
  const resumed:string[]=[];for(let batch=0;batch<6 && !resumed.includes(f.sourceInputId);batch++) await dispatchConsentWork(async(_kind,data)=>{if(data.sourceInputId)resumed.push(data.sourceInputId);return randomUUID();});
  expect(resumed).toContain(f.sourceInputId);
  await consentJob("profile_extract",embed)(job(f));
 });
});
