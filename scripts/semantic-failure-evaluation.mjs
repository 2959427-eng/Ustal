// Isolated SDK faults use a loopback server and a dummy key. Live retry is explicit.
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { parse } from 'dotenv';
const args=process.argv.slice(2), arg=n=>args[args.indexOf(n)+1];
if(!args.includes('--report') || !args.includes('--output')) throw Error('Requires --report and --output');
process.env.NODE_ENV='test';
const {assertLocalTestDatabase,getDb,getSql,schema}=await import('@ustal/database');assertLocalTestDatabase();
const live=args.includes('--live-retry');
let mode='timeout',requests=0,server;
if(live){
  if(!args.includes('--ai-env')) throw Error('Live retry requires --ai-env');
  const env=parse(fs.readFileSync(arg('--ai-env')));
  for(const k of ['OPENAI_API_KEY','OPENAI_BASE_URL','AI_MODEL_EXTRACTION']) if(env[k]) process.env[k]=env[k];
}else{
  server=http.createServer((req,res)=>{requests++;req.resume();if(mode==='error'){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Injected local service unavailable',type:'server_error'}}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.OPENAI_API_KEY='dummy-local-fault-key';
  process.env.OPENAI_BASE_URL=`http://127.0.0.1:${server.address().port}/v1`;
  process.env.AI_REQUEST_TIMEOUT_MS='200';process.env.AI_MAX_RETRIES='0';
}
process.env.AI_PROVIDER='openai';process.env.JWT_ACCESS_SECRET='local-fault-access-only';process.env.JWT_REFRESH_SECRET='local-fault-refresh-only';
const {eq,sql}=await import('drizzle-orm');
const {reprocessProfile}=await import('../apps/worker/src/reprocess.ts');
const {handleOrderExtraction}=await import('../apps/worker/src/handlers/order-extraction.ts');
const {handleMatchingRun}=await import('../apps/worker/src/handlers/matching-run.ts');
const {getAiProviders}=await import('@ustal/ai');
const {cosine,evaluateSemantic}=await import('@ustal/matching');
const db=getDb(),job=data=>({id:randomUUID(),data});
const source=JSON.parse(fs.readFileSync(arg('--report'),'utf8'));
const output={mode:live?'live-retry-and-negative-controls':'loopback-sdk-faults',startedAt:new Date().toISOString(),checks:[],calls:[]};
const save=()=>fs.writeFileSync(arg('--output'),JSON.stringify(output,null,2));
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function snapshot(profileId){
  const p=await db.query.capabilityProfiles.findFirst({where:eq(schema.capabilityProfiles.id,profileId)});
  const docs=await db.execute(sql`SELECT * FROM matching_documents WHERE profile_id=${profileId} ORDER BY id`);
  const facts=await db.execute(sql`SELECT f.* FROM matching_facts f JOIN matching_documents d ON d.id=f.document_id WHERE d.profile_id=${profileId} ORDER BY f.id`);
  const caps=await db.execute(sql`SELECT * FROM user_capabilities WHERE capability_profile_id=${profileId} ORDER BY id`);
  const resources=await db.execute(sql`SELECT * FROM user_resources WHERE capability_profile_id=${profileId} ORDER BY id`);
  return {hash:digest({p,docs,facts,caps,resources}),documents:docs.length,facts:facts.length,capabilities:caps.length,resources:resources.length};
}
async function orderState(orderId){return (await db.execute(sql`SELECT o.status,o.source_text,(SELECT count(*)::int FROM matching_documents WHERE order_id=o.id) documents,(SELECT count(*)::int FROM order_ai_extractions WHERE order_id=o.id) extractions,(SELECT count(*)::int FROM order_requirements WHERE order_id=o.id) requirements FROM orders o WHERE o.id=${orderId}`))[0];}
try{
 if(!live){
  const c=source.cases.find(c=>c.profileId&&c.orders.some(o=>o.run));
  for(mode of ['timeout','error']){
   const before=await snapshot(c.profileId),started=Date.now();let failure;
   try{await reprocessProfile(c.profileId,undefined,true);}catch(e){failure={name:e.name,status:e.status??null};}
   const after=await snapshot(c.profileId);
   output.checks.push({type:mode,target:'profile-reprocess',profileId:c.profileId,failure,elapsedMs:Date.now()-started,before,after,passed:!!failure&&before.hash===after.hash});save();
   const[o]=await db.insert(schema.orders).values({authorId:c.authorId,cityId:c.cityId,sourceText:'Нужно помочь загрузить коробки',status:'processing'}).returning();
   failure=null;try{await handleOrderExtraction(job({orderId:o.id}));}catch(e){failure={name:e.name,status:e.status??null};}
   const state=await orderState(o.id);
   output.checks.push({type:mode,target:'order-extraction',orderId:o.id,failure,state,passed:!!failure&&state.status==='processing_failed'&&state.documents===0&&state.extractions===0&&state.requirements===0});save();
  }
  // A failed pair review must preserve the previously completed run/candidates.
  if(source.extra.noCanonical){
   const oid=source.extra.noCanonical.orderId;
   // Trigger a fresh input generation locally; an unchanged completed run correctly makes no AI call.
   await db.insert(schema.rematchRequests).values({userId:source.extra.noCanonical.executorId})
     .onConflictDoUpdate({target:schema.rematchRequests.userId,set:{requestedAt:new Date(),cursor:null}});
   const counts=()=>db.execute(sql`SELECT mr.id,mr.completed_at,mc.id candidate_id FROM matching_runs mr LEFT JOIN matching_candidates mc ON mc.matching_run_id=mr.id WHERE mr.order_id=${oid} ORDER BY mr.id,mc.id`);
   const before=await counts();let failure;try{await handleMatchingRun(job({orderId:oid}));}catch(e){failure={name:e.name,status:e.status??null};}
   const after=await counts();output.checks.push({type:'error',target:'semantic-review',orderId:oid,failure,passed:!!failure&&digest(before)===digest(after)});save();
  }
  output.httpRequests=requests;
 }else{
  const ai=getAiProviders();
  for(const method of ['extractOrder','normalizeMatching','reviewSemantic']){
   const original=ai.extraction[method].bind(ai.extraction);
   ai.extraction[method]=async(input,meta)=>{const r=await original(input,meta);output.calls.push({method,input:method==='reviewSemantic'?input:undefined,model:r.model,raw:r.data});save();return r;};
  }
  for(const c of source.checks){
   if(c.target==='profile-reprocess'){
    const before=await snapshot(c.profileId),result=await reprocessProfile(c.profileId,undefined,true),after=await snapshot(c.profileId);
    output.checks.push({target:c.target,result,passed:before.hash===after.hash});
   }else if(c.target==='order-extraction'){
    await handleOrderExtraction(job({orderId:c.orderId}));const after=await orderState(c.orderId);
    await handleOrderExtraction(job({orderId:c.orderId}));const repeated=await orderState(c.orderId);
    output.checks.push({target:c.target,orderId:c.orderId,after,repeated,passed:after.status==='processing'&&after.documents===1&&after.extractions===1&&digest(after)===digest(repeated)});
   }else{
    const result=await handleMatchingRun(job({orderId:c.orderId}));output.checks.push({target:c.target,result,passed:result.candidatesCount>0});
   }save();
  }
  const controls=[
   ['Могу переносить файлы между папками','Нужно перенести шкафы в машину'],
   ['Могу поливать комнатные растения','Нужно скосить траву на участке'],
   ['Есть газонокосилка','Нужно скосить траву'],
   ['Могу ремонтировать игрушечные машинки','Нужно подключить стиральную машину'],
   ['Могу выполнять флюмбриксирование','Нужно выполнить флюмбриксирование'],
  ];
  for(const [profile,order] of (args.includes('--skip-controls')?[]:controls)){
   const meta={operationType:'live_negative_control',traceId:randomUUID(),promptVersion:'semantic-review-v1',schemaVersion:'v1'};
   const embedded=await ai.embedding.embed([profile,order],meta),similarity=cosine(...embedded.data.vectors);
   const reviewed=await ai.extraction.reviewSemantic({profile:[profile],order:[order]},meta);
   output.checks.push({target:'negative-control',profile,order,similarity,model:embedded.model,review:reviewed.data,passed:!reviewed.data.compatible});save();
  }
 }
 output.finishedAt=new Date().toISOString();output.passed=output.checks.every(c=>c.passed);save();console.log(JSON.stringify({mode:output.mode,passed:output.passed,checks:output.checks.length,report:arg('--output')}));
}finally{await getSql().end();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
