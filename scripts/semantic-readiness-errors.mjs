// Real SDK fault injection, never real credentials. Separate from the 200 live pairs.
import fs from 'node:fs';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
process.env.NODE_ENV='test';
const {assertLocalTestDatabase,getDb,getSql,schema}=await import('@ustal/database');assertLocalTestDatabase();
if(new URL(process.env.DATABASE_URL).pathname!=='/ustal_readiness_test')throw Error('Readiness DB required');
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const baseline=JSON.parse(fs.readFileSync(arg('--baseline','docs/evaluations/semantic-readiness-run.json'),'utf8'));
const dataset=JSON.parse(fs.readFileSync('docs/evaluations/semantic-readiness-dataset.json','utf8'));
const c=baseline.cases.find(c=>c.completed&&c.decision==='match');if(!c)throw Error('No completed baseline case');
const original=dataset.cases.find(x=>x.id===c.id);
const calls=baseline.calls.filter(x=>x.caseId===c.id);
const norms=calls.filter(x=>x.method==='normalizeMatching');
let mode='timeout',requests=0,embeddingRequests=0;
const server=http.createServer(async(req,res)=>{
 requests++;let body='';for await(const chunk of req)body+=chunk;
 if(mode==='timeout')return;
 if(['429','500','503'].includes(mode)){res.writeHead(Number(mode),{'Content-Type':'application/json','Retry-After':'0.01'});res.end(JSON.stringify({error:{message:'Injected isolated fault',type:'test_error'}}));return;}
 let request={};try{request=JSON.parse(body);}catch{}
 let payload={};
 if(mode==='missing_embedding'){
  if(req.url.includes('/embeddings')){embeddingRequests++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:[],usage:{prompt_tokens:0,total_tokens:0}}));return;}
  const name=request.response_format?.json_schema?.name;
  payload=name==='order_extraction'?calls.find(x=>x.method==='extractOrder').raw:
   norms[JSON.parse(request.messages?.[1]?.content??'{}').kind==='order'?1:0]?.raw;
  if(name==='matching_facts_v2'){
   const spans=JSON.parse(request.messages[1].content).EVIDENCE_SPANS;
   if(spans)payload={facts:payload.facts.map(f=>({...f,evidence:spans.find(s=>s.text.includes(f.evidence))?.id??spans[0].id,
    orderResourceSupply:JSON.parse(request.messages[1].content).kind==='order'&&f.kind==='resource'?'unspecified':null}))};
  }
 }
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'local-fault-response',choices:[{message:{content:mode==='malformed_json'?'{broken':JSON.stringify(payload)}}],usage:{prompt_tokens:0,completion_tokens:0}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
Object.assign(process.env,{AI_PROVIDER:'openai',OPENAI_API_KEY:'dummy-error-evaluation-key',OPENAI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,AI_REQUEST_TIMEOUT_MS:'200',AI_MAX_RETRIES:'1',JWT_ACCESS_SECRET:'local-error-access-only',JWT_REFRESH_SECRET:'local-error-refresh-only'});
const {eq,sql}=await import('drizzle-orm');
const {reprocessProfile}=await import('../apps/worker/src/reprocess.ts');
const {handleOrderExtraction}=await import('../apps/worker/src/handlers/order-extraction.ts');
const db=getDb(),digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
console.info=()=>{};console.error=()=>{};
const report={scope:'Loopback SDK fault injection; dummy key; recorded live outputs only to reach missing-embedding stage',startedAt:new Date().toISOString(),checks:[]};
const file=arg('--output','docs/evaluations/semantic-readiness-errors.json'),save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2));
async function profileHash(){const rows=await db.execute(sql`SELECT row_to_json(cp) p,(SELECT json_agg(d ORDER BY d.id) FROM matching_documents d WHERE d.profile_id=cp.id) docs,(SELECT json_agg(f ORDER BY f.id) FROM matching_facts f JOIN matching_documents d ON d.id=f.document_id WHERE d.profile_id=cp.id) facts,(SELECT json_agg(uc ORDER BY uc.id) FROM user_capabilities uc WHERE uc.capability_profile_id=cp.id) caps,(SELECT json_agg(ur ORDER BY ur.id) FROM user_resources ur WHERE ur.capability_profile_id=cp.id) resources,(SELECT row_to_json(pe) FROM profile_embeddings pe WHERE pe.capability_profile_id=cp.id) embedding FROM capability_profiles cp WHERE cp.id=${c.profileId}`);return digest(rows);}
try{
 for(mode of ['timeout','429','500','503','malformed_json','malformed_schema','missing_embedding']){
  let n=requests,e=embeddingRequests,start=performance.now(),error;const before=await profileHash();
  try{await reprocessProfile(c.profileId,undefined,true);}catch(e){error={name:e.name,status:e.status??null,message:String(e.message).slice(0,160)};}
  const after=await profileHash();report.checks.push({mode,target:'existing_profile',error,requests:requests-n,embeddingRequests:embeddingRequests-e,ms:performance.now()-start,before,after,passed:!!error&&before===after&&(mode!=='missing_embedding'||embeddingRequests>e)});save();
  const[o]=await db.insert(schema.orders).values({authorId:c.authorId,cityId:c.cityId,sourceText:original.order_text,status:'processing'}).returning();
  n=requests;e=embeddingRequests;start=performance.now();error=null;
  try{await handleOrderExtraction({id:randomUUID(),data:{orderId:o.id}});}catch(e){error={name:e.name,status:e.status??null,message:String(e.message).slice(0,160)};}
  const[state]=await db.execute(sql`SELECT status,source_text,(SELECT count(*)::int FROM matching_documents WHERE order_id=o.id) docs,(SELECT count(*)::int FROM order_requirements WHERE order_id=o.id) requirements,(SELECT count(*)::int FROM order_ai_extractions WHERE order_id=o.id) extractions FROM orders o WHERE id=${o.id}`);
  report.checks.push({mode,target:'new_order',orderId:o.id,error,requests:requests-n,embeddingRequests:embeddingRequests-e,ms:performance.now()-start,state,passed:!!error&&state.status==='processing_failed'&&state.source_text===original.order_text&&state.docs===0&&state.requirements===0&&state.extractions===0&&(mode!=='missing_embedding'||embeddingRequests>e)});save();
 }
 report.finishedAt=new Date().toISOString();report.passed=report.checks.every(c=>c.passed);save();console.log(JSON.stringify({checks:report.checks.length,passed:report.passed}));
}finally{await getSql().end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
