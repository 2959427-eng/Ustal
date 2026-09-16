// Evaluation-only orchestration. Real handlers/providers; explicit localhost test DB guard.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
if(!args.includes('--live')||!args.includes('--ai-env'))throw Error('Requires explicit --live --ai-env');
process.env.NODE_ENV='test';
const {assertLocalTestDatabase,getDb,getSql,schema}=await import('@ustal/database');assertLocalTestDatabase();
if(new URL(process.env.DATABASE_URL).pathname!=='/ustal_readiness_test')throw Error('Dedicated readiness DB required');
const env=parse(fs.readFileSync(arg('--ai-env')));
for(const k of ['OPENAI_API_KEY','OPENAI_BASE_URL','AI_MODEL_EXTRACTION','AI_MODEL_NORMALIZATION','AI_MODEL_EMBEDDING','AI_MODEL_SEMANTIC_REVIEW'])if(env[k])process.env[k]=env[k];
process.env.AI_PROVIDER='openai';process.env.JWT_ACCESS_SECRET='readiness-local-access-only';process.env.JWT_REFRESH_SECRET='readiness-local-refresh-only';
if(!process.env.OPENAI_API_KEY)throw Error('No live key configured');
const dataset=JSON.parse(fs.readFileSync(arg('--dataset','docs/evaluations/semantic-readiness-dataset.json'),'utf8'));
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
if(hash(dataset.cases)!==dataset.sha256)throw Error('Frozen labels modified');
const file=path.resolve(arg('--output','docs/evaluations/semantic-readiness-run.json'));
const phase=arg('--phase','baseline'),concurrency=Number(arg('--concurrency','4'));
const caseGapMs=Number(arg('--case-gap-ms','0'));
const report=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{startedAt:new Date().toISOString(),datasetSha:dataset.sha256,database:'ustal_readiness_test',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),cases:[],calls:[],http:[],thresholds:{},repeats:[],phaseTimings:[]};
if(report.datasetSha!==dataset.sha256)throw Error('Report belongs to different labels');
const save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2));
const context=new AsyncLocalStorage();
const realFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const ctx=context.getStore()??{phase:'setup'},started=performance.now();
 let request;try{request=JSON.parse(init?.body??'{}');}catch{}
 const response=await realFetch(input,init);
 let wire;try{wire=await response.clone().json();}catch{}
 report.http.push({...ctx,endpoint:new URL(typeof input==='string'?input:input.url??String(input)).pathname,status:response.status,latencyMs:performance.now()-started,requestedModel:request?.model,model:wire?.model,usage:wire?.usage??null,rawContent:response.ok?wire?.choices?.[0]?.message?.content:undefined,errorType:response.ok?undefined:wire?.error?.type});
 return response;
};
const {eq,and,sql}=await import('drizzle-orm');
const {getAiProviders}=await import('@ustal/ai');
const {SEMANTIC_POLICY,cosine}=await import('@ustal/matching');
const {handleProfileExtraction}=await import('../apps/worker/src/handlers/profile-extraction.ts');
const {handleOrderExtraction}=await import('../apps/worker/src/handlers/order-extraction.ts');
const {handleMatchingRun}=await import('../apps/worker/src/handlers/matching-run.ts');
const db=getDb(),ai=getAiProviders();
report.policy=structuredClone(SEMANTIC_POLICY);
const files=['apps/worker/src/handlers/profile-extraction.ts','apps/worker/src/handlers/order-extraction.ts','apps/worker/src/handlers/matching-run.ts','apps/worker/src/semantic.ts','packages/ai/src/providers/openai.ts','packages/ai/src/source-evidence.ts','packages/matching/src/semantic.ts','packages/database/src/seed.ts','packages/config/src/env.ts','packages/validation/src/semantic.ts'];
const codeHashes=Object.fromEntries(files.map(p=>[p,hash(fs.readFileSync(p,'utf8'))]));
if(report.codeHashes&&JSON.stringify(report.codeHashes)!==JSON.stringify(codeHashes))throw Error('Code changed; use a new output file to preserve baseline');
report.codeHashes=codeHashes;
const memo=new Map(report.calls.filter(c=>c.method==='reviewSemantic'&&c.result).map(c=>[hash(c.input),c.result]));
for(const [provider,method] of [[ai.extraction,'extractCapabilityProfile'],[ai.extraction,'extractOrder'],[ai.extraction,'normalizeMatching'],[ai.extraction,'reviewSemantic'],[ai.embedding,'embed'],[ai.moderation,'moderate']]){
 const original=provider[method].bind(provider);
 provider[method]=async(input,meta)=>{
  const ctx=context.getStore()??{phase:'setup'},start=performance.now(),entry={...ctx,method,traceId:meta.traceId};
  try{
   const cached=method==='reviewSemantic'&&ctx.phase==='sweep'?memo.get(hash(input)):undefined;
   const r=cached??await original(input,meta);
   Object.assign(entry,{model:r.model,provider:r.provider,latencyMs:performance.now()-start,tokensInput:r.tokensInput,tokensOutput:r.tokensOutput,validationAttempts:r.validationAttempts,cached:!!cached});
   if(method==='embed')entry.embedding={texts:input,vectors:r.data.vectors.map(v=>({dimensions:v.length,norm:Math.sqrt(v.reduce((a,x)=>a+x*x,0)),sha256:hash(v)}))};
   else entry.raw=r.data;
   if(method==='reviewSemantic'){entry.input=input;entry.result=r;memo.set(hash(input),r);}
   report.calls.push(entry);return r;
  }catch(e){report.calls.push({...entry,latencyMs:performance.now()-start,error:{name:e.name,status:e.status??null}});throw e;}
 };
}
// Worker stage logs are verbose; retain exact diagnostics in case records, not console spam.
console.info=()=>{};console.error=(...values)=>{if(!String(values[0]).startsWith('[order-extraction:')&&!String(values[0]).startsWith('[ai:validation:'))process.stderr.write('Evaluation diagnostic\n');};
const nodes=await db.select().from(schema.ontologyNodes),keys=new Map(nodes.map(n=>[n.id,n.canonicalKey]));
const job=data=>({id:randomUUID(),data});
async function user(cityId){const[u]=await db.insert(schema.users).values({phone:randomUUID().slice(0,20),passwordHash:'readiness-isolated',status:'active'}).returning();await db.insert(schema.userProfiles).values({userId:u.id,name:'EVAL only',cityId,acceptedRulesAt:new Date(),acceptedPdnAt:new Date()});return u.id;}
async function document(owner){const where=owner.profileId?eq(schema.matchingDocuments.profileId,owner.profileId):eq(schema.matchingDocuments.orderId,owner.orderId);const d=await db.query.matchingDocuments.findFirst({where,orderBy:(t,{desc})=>desc(t.processedAt)});const facts=d?await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId,d.id)):[];return {d,facts};}
const present=({d,facts})=>({id:d?.id,processingVersion:d?.processingVersion,model:d?.embeddingModel,dimensions:d?.embedding?.length,facts:facts.map(({embedding,...f})=>({...f,canonicalKeys:f.nodeIds.map(id=>keys.get(id)),dimensions:embedding?.length,embeddingSha:embedding?hash(embedding):null}))});
async function match(orderId,userId){
 const started=performance.now(),r=await handleMatchingRun(job({orderId}));
 const t='matchingRunId'in r?await db.query.matchingTraces.findFirst({where:and(eq(schema.matchingTraces.matchingRunId,r.matchingRunId),eq(schema.matchingTraces.userId,userId))}):null;
 const c='matchingRunId'in r?await db.query.matchingCandidates.findFirst({where:and(eq(schema.matchingCandidates.matchingRunId,r.matchingRunId),eq(schema.matchingCandidates.userId,userId))}):null;
 return {decision:c?'match':'reject',type:t?.decision??'reject',score:Number(c?.score??0),trace:t?.detail??{reason:'not_shortlisted_or_not_published'},matchingMs:performance.now()-started,run:r};
}
async function runCase(c,iteration=0){
 const entry={id:c.id,iteration,expected_label:c.expected_label,group:c.group,split:c.split,startedAt:new Date().toISOString()};
 const destination=iteration?report.repeats:report.cases;destination.push(entry);
 await context.run({caseId:c.id,phase:iteration?'repeat':'baseline',iteration},async()=>{
  const start=performance.now();let stage='fixture';
  try{
   const[city]=await db.insert(schema.cities).values({name:`EVAL ${c.id} ${randomUUID().slice(0,8)}`,regionName:'TEST',federalDistrict:'TEST',timezone:'Asia/Vladivostok',isActive:false}).returning();entry.cityId=city.id;
   entry.authorId=await user(city.id);entry.userId=await user(city.id);
   const[source]=await db.insert(schema.profileSourceInputs).values({userId:entry.userId,inputType:'text',rawText:c.profile_text,status:'confirmed'}).returning();
   stage='profile';const p=await handleProfileExtraction(job({userId:entry.userId,sourceInputId:source.id}));entry.profileId=p.profileId;
   await db.update(schema.capabilityProfiles).set({status:'applied'}).where(eq(schema.capabilityProfiles.id,p.profileId));
   const pd=await document({profileId:p.profileId});entry.profile=present(pd);
   const[o]=await db.insert(schema.orders).values({authorId:entry.authorId,cityId:city.id,sourceText:c.order_text,status:'processing'}).returning();entry.orderId=o.id;
   stage='order';await handleOrderExtraction(job({orderId:o.id}));
   const stored=await db.query.orders.findFirst({where:eq(schema.orders.id,o.id)}),od=await document({orderId:o.id});entry.order=present(od);entry.riskLevel=stored.riskLevel;entry.moderation=stored.moderationStatus;
   entry.documentSimilarity=cosine(pd.d?.embedding,od.d?.embedding);
   entry.phraseSimilarities=od.facts.filter(f=>f.kind==='capability').map(r=>({order:r.phrase,profile:pd.facts.map(f=>({kind:f.kind,phrase:f.phrase,cosine:cosine(f.embedding,r.embedding)}))}));
   if(!['allow','allow_with_warning'].includes(stored.moderationStatus)){Object.assign(entry,{decision:'reject',type:'reject',score:0,trace:{reason:'moderation_'+stored.moderationStatus},matchingMs:0});}
   else{await db.update(schema.orders).set({status:'published'}).where(eq(schema.orders.id,o.id));stage='matching';Object.assign(entry,await match(o.id,entry.userId));}
   entry.completed=true;
  }catch(e){entry.completed=false;entry.decision='error';entry.type='error';entry.score=0;entry.error={stage,name:e.name,status:e.status??null,message:String(e.message).replace(/https?:\/\/\S+|sk-[\w-]+|org-[A-Za-z0-9]+|Bearer \S+/gi,'[REDACTED]').slice(0,350)};}
  entry.fullMs=performance.now()-start;entry.finishedAt=new Date().toISOString();save();
 });
 console.log(JSON.stringify({phase:iteration?'repeat':'baseline',id:c.id,iteration,decision:entry.decision,type:entry.type,ms:Math.round(entry.fullMs),done:destination.filter(x=>x.finishedAt).length}));
}
async function pool(items,fn){let cursor=0,nextStart=Date.now();await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<items.length){const item=items[cursor++];const slot=Math.max(Date.now(),nextStart);nextStart=slot+caseGapMs;await new Promise(r=>setTimeout(r,Math.max(0,slot-Date.now())));await fn(item);}}));}
const begin=performance.now();
try{
 if(phase==='baseline')await pool(dataset.cases.filter(c=>!report.cases.some(r=>r.id===c.id&&r.finishedAt)),c=>runCase(c));
 else if(phase==='repeat'){
  const tasks=dataset.cases.filter(c=>c.repeat_selected).flatMap(c=>[1,2].filter(i=>!report.repeats.some(r=>r.id===c.id&&r.iteration===i&&r.finishedAt)).map(i=>({c,i})));
  await pool(tasks,({c,i})=>runCase(c,i));
 }else if(phase==='sweep'){
  for(const threshold of [0.60,0.65,0.70,0.75,0.78,0.80,0.85]){
   SEMANTIC_POLICY.semanticMin=threshold;
   const entries=report.thresholds[String(threshold)]??=[];
   await pool(report.cases.filter(c=>!entries.some(e=>e.id===c.id)),async c=>context.run({phase:'sweep',caseId:c.id,threshold},async()=>{
    let result;
    if(!c.completed||!c.run)result={decision:c.decision,type:c.type,score:c.score,trace:c.trace,error:c.error};
    else try{result=await match(c.orderId,c.userId);}catch(e){result={decision:'error',error:{name:e.name,status:e.status??null}};}
    entries.push({id:c.id,...result});save();
   }));
   console.log(JSON.stringify({phase:'sweep',threshold,completed:entries.length}));
  }
 }else throw Error('Unknown phase');
 report.phaseTimings.push({phase,concurrency,caseGapMs,wallMs:performance.now()-begin,finishedAt:new Date().toISOString()});save();
}finally{await getSql().end();}
