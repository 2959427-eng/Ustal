// Isolated persisted-state/idempotency probes plus live recovery. No production access.
import fs from 'node:fs';
import {parse} from 'dotenv';
import {createHash,randomUUID} from 'node:crypto';
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;if(!args.includes('--ai-env')||!args.includes('--live'))throw Error('Explicit live opt-in required');
process.env.NODE_ENV='test';
const {assertLocalTestDatabase,getDb,getSql,schema}=await import('@ustal/database');assertLocalTestDatabase();
if(new URL(process.env.DATABASE_URL).pathname!=='/ustal_readiness_test')throw Error('Readiness DB required');
const env=parse(fs.readFileSync(args[args.indexOf('--ai-env')+1]));
for(const k of ['OPENAI_API_KEY','OPENAI_BASE_URL','AI_MODEL_EXTRACTION','AI_MODEL_SEMANTIC_REVIEW'])if(env[k])process.env[k]=env[k];
Object.assign(process.env,{AI_PROVIDER:'openai',JWT_ACCESS_SECRET:'readiness-local-access-only',JWT_REFRESH_SECRET:'readiness-local-refresh-only'});
const {eq,sql}=await import('drizzle-orm');
const {reprocessProfile}=await import('../apps/worker/src/reprocess.ts');
const {handleMatchingRun}=await import('../apps/worker/src/handlers/matching-run.ts');
const {handleOrderExtraction}=await import('../apps/worker/src/handlers/order-extraction.ts');
const {getAiProviders}=await import('@ustal/ai');
const db=getDb(),ai=getAiProviders(),job=data=>({id:randomUUID(),data});
const source=JSON.parse(fs.readFileSync(arg('--baseline','docs/evaluations/semantic-readiness-run.json'),'utf8')),faults=JSON.parse(fs.readFileSync(arg('--faults','docs/evaluations/semantic-readiness-errors.json'),'utf8'));
const c=source.cases.find(c=>c.completed&&c.type==='exact');
const out={startedAt:new Date().toISOString(),checks:[],calls:[],scope:'Extra local state probes, separate from 200-pair quality set'};
const save=()=>fs.writeFileSync(arg('--output','docs/evaluations/semantic-readiness-extra.json'),JSON.stringify(out,null,2));
console.info=()=>{};console.error=()=>{};
for(const [p,m]of[[ai.extraction,'extractOrder'],[ai.extraction,'normalizeMatching'],[ai.extraction,'reviewSemantic'],[ai.embedding,'embed']]){const original=p[m].bind(p);p[m]=async(...args)=>{const r=await original(...args);out.calls.push({method:m,model:r.model,tokensInput:r.tokensInput,tokensOutput:r.tokensOutput,raw:m==='embed'?{vectors:r.data.vectors.length,dimensions:r.data.vectors.map(v=>v.length)}:r.data});save();return r;};}
async function counts(){return (await db.execute(sql`select (select count(*)::int from matching_documents where profile_id=${c.profileId}) docs,(select count(*)::int from matching_facts f join matching_documents d on d.id=f.document_id where d.profile_id=${c.profileId}) facts,(select count(*)::int from user_capabilities where capability_profile_id=${c.profileId}) caps,(select count(*)::int from user_resources where capability_profile_id=${c.profileId}) resources`))[0];}
try{
 const before=await counts(),r1=await reprocessProfile(c.profileId,undefined,true),r2=await reprocessProfile(c.profileId,undefined,true),after=await counts();
 out.checks.push({name:'reprocess_profile_twice',before,after,r1,r2,passed:JSON.stringify(before)===JSON.stringify(after)&&r1.reused&&r2.reused});save();
 const first=await handleMatchingRun(job({orderId:c.orderId}));
 const runs=await Promise.all(Array.from({length:3},()=>handleMatchingRun(job({orderId:c.orderId}))));
 const[dupes]=await db.execute(sql`select count(*)::int n from (select matching_run_id,user_id from matching_candidates group by matching_run_id,user_id having count(*)>1) q`);
 out.checks.push({name:'concurrent_rematch_same_order',first,runs,duplicatePairs:dupes.n,passed:runs.every(x=>x.matchingRunId===first.matchingRunId)&&dupes.n===0});save();
 for(const fault of faults.checks.filter(x=>x.target==='new_order')){
  const before=await db.query.orders.findFirst({where:eq(schema.orders.id,fault.orderId)});
  let failure;try{await handleOrderExtraction(job({orderId:fault.orderId}));}catch(e){failure={name:e.name,status:e.status??null};}
  const after=await db.query.orders.findFirst({where:eq(schema.orders.id,fault.orderId)});
  const[rows]=await db.execute(sql`select (select count(*)::int from matching_documents where order_id=${fault.orderId}) docs,(select count(*)::int from order_ai_extractions where order_id=${fault.orderId}) extractions`);
  out.checks.push({name:'live_recovery_'+fault.mode,orderId:fault.orderId,before:before.status,after:after.status,sourcePreserved:before.sourceText===after.sourceText,rows,failure,passed:!failure&&after.status!=='processing_failed'&&before.sourceText===after.sourceText&&rows.docs===1&&rows.extractions===1});save();
  await new Promise(r=>setTimeout(r,7000));
 }
 // Only a stress-fixture profile is mutated; restore every original vector in finally.
 const docs=await db.select().from(schema.matchingDocuments).where(eq(schema.matchingDocuments.profileId,c.profileId));
 const facts=await db.execute(sql`select f.id,f.embedding::text embedding from matching_facts f join matching_documents d on d.id=f.document_id where d.profile_id=${c.profileId}`);
 const[legacy]=await db.execute(sql`select embedding::text embedding from profile_embeddings where capability_profile_id=${c.profileId}`);
 try{
  await db.execute(sql`update matching_documents set embedding=null where profile_id=${c.profileId}`);
  await db.execute(sql`update matching_facts set embedding=null where document_id in (select id from matching_documents where profile_id=${c.profileId})`);
  await db.execute(sql`update profile_embeddings set embedding=null where capability_profile_id=${c.profileId}`);
  const result=await handleMatchingRun(job({orderId:c.orderId}));
  const[found]=await db.execute(sql`select count(*)::int n from matching_candidates where matching_run_id=${result.matchingRunId} and user_id=${c.userId}`);
  out.checks.push({name:'persisted_embeddings_missing_canonical_survives',result,candidates:found.n,passed:found.n===1});
 }catch(e){out.checks.push({name:'persisted_embeddings_missing_canonical_survives',error:{name:e.name,message:String(e.message).slice(0,150)},passed:false});}
 finally{
  for(const d of docs)await db.update(schema.matchingDocuments).set({embedding:d.embedding}).where(eq(schema.matchingDocuments.id,d.id));
  for(const f of facts)await db.execute(sql`update matching_facts set embedding=${f.embedding}::vector where id=${f.id}`);
  if(legacy)await db.execute(sql`update profile_embeddings set embedding=${legacy.embedding}::vector where capability_profile_id=${c.profileId}`);
 }
 out.finishedAt=new Date().toISOString();out.passed=out.checks.every(c=>c.passed);save();console.log(JSON.stringify({checks:out.checks.length,passed:out.passed}));
}finally{await getSql().end();}
