// Re-evaluate ALL frozen live snapshots after a scoring-only fix, with fresh live reviewer calls.
import fs from 'node:fs';
import {parse} from 'dotenv';
import {createHash,randomUUID} from 'node:crypto';
const args=process.argv.slice(2);if(!args.includes('--live')||!args.includes('--ai-env'))throw Error('Explicit opt-in required');
process.env.NODE_ENV='test';
const {assertLocalTestDatabase,getDb,getSql,schema}=await import('@ustal/database');assertLocalTestDatabase();
if(new URL(process.env.DATABASE_URL).pathname!=='/ustal_readiness_test')throw Error('Readiness DB required');
const env=parse(fs.readFileSync(args[args.indexOf('--ai-env')+1]));
for(const k of ['OPENAI_API_KEY','OPENAI_BASE_URL','AI_MODEL_EXTRACTION','AI_MODEL_SEMANTIC_REVIEW'])if(env[k])process.env[k]=env[k];
Object.assign(process.env,{AI_PROVIDER:'openai',JWT_ACCESS_SECRET:'readiness-local-access-only',JWT_REFRESH_SECRET:'readiness-local-refresh-only'});
const baseline=JSON.parse(fs.readFileSync('docs/evaluations/semantic-readiness-paced-run.json','utf8'));
if(baseline.cases.length!==200||baseline.cases.some(c=>!c.finishedAt))throw Error('Complete baseline required');
const hash=x=>createHash('sha256').update(x).digest('hex');
for(const [p,h] of Object.entries(baseline.codeHashes))if(p!=='packages/matching/src/semantic.ts'&&hash(fs.readFileSync(p,'utf8'))!==h)throw Error('Non-scoring pipeline changed: fresh full extraction eval required');
const {eq,and}=await import('drizzle-orm');
const {getAiProviders}=await import('@ustal/ai');
const {SEMANTIC_POLICY}=await import('@ustal/matching');
const {handleMatchingRun}=await import('../apps/worker/src/handlers/matching-run.ts');
const db=getDb(),ai=getAiProviders(),memo=new Map();
const out={startedAt:new Date().toISOString(),scope:'Scoring-only change. All 200 saved LIVE extractions/vectors reused unchanged; fresh live semantic reviews at default threshold, memoized for paired sweep. No mock extraction or embedding.',datasetSha:baseline.datasetSha,policy:structuredClone(SEMANTIC_POLICY),codeHashes:Object.fromEntries(Object.keys(baseline.codeHashes).map(p=>[p,hash(fs.readFileSync(p,'utf8'))])),cases:[],thresholds:{},calls:[],http:[]};
let context={};const realFetch=global.fetch;
global.fetch=async(...args)=>{const start=performance.now(),r=await realFetch(...args);let wire;try{wire=await r.clone().json();}catch{}out.http.push({...context,status:r.status,model:wire?.model,usage:wire?.usage,latencyMs:performance.now()-start});return r;};
const original=ai.extraction.reviewSemantic.bind(ai.extraction);
ai.extraction.reviewSemantic=async(input,meta)=>{const start=performance.now(),key=JSON.stringify(input),cached=context.phase==='sweep'?memo.get(key):null;const r=cached??await original(input,meta);memo.set(key,r);out.calls.push({...context,method:'reviewSemantic',input,raw:r.data,model:r.model,tokensInput:r.tokensInput,tokensOutput:r.tokensOutput,cached:!!cached,latencyMs:performance.now()-start});return r;};
console.info=()=>{};console.error=()=>{};
const save=()=>fs.writeFileSync('docs/evaluations/semantic-readiness-postfix.json',JSON.stringify(out,null,2));
async function evaluate(c){const start=performance.now();if(!c.completed||!c.run)return {id:c.id,decision:c.decision,type:c.type,score:c.score,trace:c.trace,error:c.error,completed:c.completed};try{const r=await handleMatchingRun({id:randomUUID(),data:{orderId:c.orderId}});const t=await db.query.matchingTraces.findFirst({where:and(eq(schema.matchingTraces.matchingRunId,r.matchingRunId),eq(schema.matchingTraces.userId,c.userId))});const candidate=await db.query.matchingCandidates.findFirst({where:and(eq(schema.matchingCandidates.matchingRunId,r.matchingRunId),eq(schema.matchingCandidates.userId,c.userId))});return {id:c.id,decision:candidate?'match':'reject',type:t?.decision??'reject',score:Number(candidate?.score??0),trace:t?.detail??{reason:'not_shortlisted'},run:r,matchingMs:performance.now()-start,completed:true};}catch(e){return {id:c.id,decision:'error',type:'error',score:0,error:{name:e.name,status:e.status??null},completed:false};}}
try{
 for(const c of baseline.cases){context={phase:'postfix',caseId:c.id,threshold:SEMANTIC_POLICY.semanticMin};out.cases.push(await evaluate(c));save();}
 console.log(JSON.stringify({phase:'postfix',cases:out.cases.length}));
 for(const threshold of [.60,.65,.70,.75,.78,.80,.85]){SEMANTIC_POLICY.semanticMin=threshold;const rows=out.thresholds[String(threshold)]=[];for(const c of baseline.cases){context={phase:'sweep',caseId:c.id,threshold};rows.push(await evaluate(c));}save();console.log(JSON.stringify({phase:'postfix-sweep',threshold,cases:rows.length}));}
 out.finishedAt=new Date().toISOString();save();
}finally{await getSql().end();}
