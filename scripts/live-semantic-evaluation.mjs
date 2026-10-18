// Explicit opt-in live model evaluation. Never imports credentials into a workspace file.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parse } from "dotenv";

const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
if(!args.includes("--live") || !args.includes("--ai-env") || !args.includes("--output")) throw Error("Requires --live --ai-env PATH --output PATH and an explicit local test DATABASE_URL");
process.env.NODE_ENV="test";
const {assertLocalTestDatabase,getDb,getSql,schema}=await import("@ustal/database");
assertLocalTestDatabase();
const aiEnv=parse(fs.readFileSync(arg("--ai-env")));
for(const key of ["OPENAI_API_KEY","OPENAI_BASE_URL","AI_MODEL_EXTRACTION","AI_MODEL_EMBEDDING","AI_MODEL_MODERATION"]) if(aiEnv[key]) process.env[key]=aiEnv[key];
process.env.AI_PROVIDER="openai";
process.env.JWT_ACCESS_SECRET="local-live-evaluation-access-only";
process.env.JWT_REFRESH_SECRET="local-live-evaluation-refresh-only";
if(!process.env.OPENAI_API_KEY) throw Error("Live AI credentials unavailable");
const {eq,and,sql}=await import("drizzle-orm");
const {getAiProviders}=await import("@ustal/ai");
const {cosine,evaluateSemantic}=await import("@ustal/matching");
const {handleProfileExtraction}=await import("../apps/worker/src/handlers/profile-extraction.ts");
const {handleOrderExtraction}=await import("../apps/worker/src/handlers/order-extraction.ts");
const {handleMatchingRun}=await import("../apps/worker/src/handlers/matching-run.ts");
const {reprocessProfile}=await import("../apps/worker/src/reprocess.ts");
const {persistDocument}=await import("../apps/worker/src/semantic.ts");
const db=getDb(),ai=getAiProviders();
const output=path.resolve(arg("--output"));fs.mkdirSync(path.dirname(output),{recursive:true});
const report={startedAt:new Date().toISOString(),database:new URL(process.env.DATABASE_URL).pathname,provider:"openai",cases:[],calls:[],extra:{}};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
let active="setup";
for(const method of ["extractCapabilityProfile","extractOrder","normalizeMatching","reviewSemantic"]){
  const original=ai.extraction[method].bind(ai.extraction);
  ai.extraction[method]=async(input,meta)=>{
    const result=await original(input,meta);
    report.calls.push({case:active,method,traceId:meta.traceId,model:result.model,latencyMs:result.latencyMs,tokensInput:result.tokensInput,tokensOutput:result.tokensOutput,raw:result.data});save();
    return result;
  };
}
const originalEmbed=ai.embedding.embed.bind(ai.embedding);
ai.embedding.embed=async(texts,meta)=>{
  const result=await originalEmbed(texts,meta);
  report.calls.push({case:active,method:"embed",traceId:meta.traceId,model:result.model,tokensInput:result.tokensInput,texts,vectors:result.data.vectors.map(v=>({dimensions:v.length,norm:Math.sqrt(v.reduce((s,x)=>s+x*x,0)),sha256:createHash("sha256").update(JSON.stringify(v)).digest("hex")}))});save();
  return result;
};
const nodes=await db.select().from(schema.ontologyNodes),keys=new Map(nodes.map(n=>[n.id,n.canonicalKey]));
const job=data=>({id:randomUUID(),data});
async function fixtureCity(label){const[c]=await db.insert(schema.cities).values({name:`LIVE ${label} ${randomUUID().slice(0,8)}`,regionName:"TEST",federalDistrict:"TEST",timezone:"Asia/Vladivostok",isActive:false}).returning();return c.id;}
async function user(cityId){const[u]=await db.insert(schema.users).values({phone:randomUUID().slice(0,20),passwordHash:"isolated-live-test",status:"active"}).returning();await db.insert(schema.userProfiles).values({userId:u.id,cityId,name:"LIVE semantic fixture",acceptedRulesAt:new Date(),acceptedPdnAt:new Date()});return u.id;}
async function document(owner){const where=owner.profileId?eq(schema.matchingDocuments.profileId,owner.profileId):eq(schema.matchingDocuments.orderId,owner.orderId);const d=await db.query.matchingDocuments.findFirst({where,orderBy:(t,{desc})=>desc(t.processedAt)});const facts=d?await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId,d.id)):[];return {d,facts};}
function present({d,facts}){return {id:d?.id,processingVersion:d?.processingVersion,embeddingModel:d?.embeddingModel,embeddingDimensions:d?.embedding?.length,facts:facts.map(({embedding,nodeIds,...f})=>({...f,canonicalKeys:nodeIds.map(id=>keys.get(id)),embeddingDimensions:embedding?.length}))};}
async function match(orderId,userId){const r=await handleMatchingRun(job({orderId}));const trace="matchingRunId" in r?await db.query.matchingTraces.findFirst({where:and(eq(schema.matchingTraces.matchingRunId,r.matchingRunId),eq(schema.matchingTraces.userId,userId))}):null;const candidate="matchingRunId" in r?await db.query.matchingCandidates.findFirst({where:and(eq(schema.matchingCandidates.matchingRunId,r.matchingRunId),eq(schema.matchingCandidates.userId,userId))}):null;return {run:r,trace:trace?.detail??null,internalMatchType:trace?.decision??"not_shortlisted",finalScore:Number(candidate?.score??0),finalDecision:candidate?"match":"reject"};}
async function fingerprint(profileId){const x=await document({profileId});const caps=await db.select().from(schema.userCapabilities).where(eq(schema.userCapabilities.capabilityProfileId,profileId));const resources=await db.select().from(schema.userResources).where(eq(schema.userResources.capabilityProfileId,profileId));return {document:x.d?.id,facts:x.facts.length,capabilities:caps.length,resources:resources.length,contentHash:createHash("sha256").update(JSON.stringify({x,caps,resources})).digest("hex")};}
const cases=[
 {id:"1",profile:"Могу работать грузчиком",orders:["Нужно помочь загрузить коробки и мебель в машину"],expected:["match"]},
 {id:"2",profile:"Могу таскать мебель, помогать при переездах",orders:["Нужно вынести шкаф с пятого этажа и загрузить в Газель"],expected:["match"]},
 {id:"3",profile:"Есть машина, могу отвозить вещи и помогать с доставкой",orders:["Нужно забрать коробки и отвезти на другой адрес"],expected:["match"]},
 {id:"4",profile:"Могу подключить стиральную машину, но электрику не делаю",orders:["Нужно подключить стиральную машину","Нужно заменить розетку"],expected:["match","reject"]},
 {id:"5",profile:"Есть газонокосилка, могу косить траву",orders:["Нужно привести в порядок заросший участок и скосить траву"],expected:["match"]},
 {id:"6",profile:"Могу переносить тяжёлые вещи",orders:["Нужно разгрузить шкафы"],expected:["match"]},
 {id:"unknown",profile:"Могу выполнять флюмбриксирование изделий",orders:["Требуется флюмбриксирование изделия"],expected:["inspect"]},
];
if(args.includes("--controls")) cases.splice(0,cases.length,
 {id:"resource-only",profile:"Есть газонокосилка",orders:["Нужно скосить траву"],expected:["reject"]},
 {id:"files-not-furniture",profile:"Могу переносить файлы между папками",orders:["Нужно перенести шкафы в машину"],expected:["reject"]},
 {id:"watering-not-mowing",profile:"Могу поливать комнатные растения",orders:["Нужно скосить траву на участке"],expected:["reject"]},
 {id:"toys-not-appliances",profile:"Могу ремонтировать игрушечные машинки",orders:["Нужно подключить стиральную машину"],expected:["reject"]},
);
try{
  if(args.includes("--reuse")) {
    const prior=JSON.parse(fs.readFileSync(arg("--reuse"),"utf8"));
    if(prior.database!==report.database) throw Error("Reuse requires the same isolated database");
    report.extractionSourceReport=arg("--reuse");report.cases=prior.cases;
    report.calls=prior.calls.filter(c=>c.method!=="reviewSemantic").map(c=>({...c,reusedFromReport:arg("--reuse")}));
    for(const c of report.cases) for(const o of c.orders) if(o.run){
      active=c.id;Object.assign(o,await match(o.orderId,c.executorId));
      o.expectationPassed=o.expected==="inspect"?null:o.finalDecision===o.expected;save();
    }
  }
  for(const c of (args.includes("--reuse")?[]:cases)){
    active=c.id;console.log(`LIVE_CASE_START ${active}`);
    const cityId=await fixtureCity(active),authorId=await user(cityId),executorId=await user(cityId);
    const entry={id:c.id,sourceProfile:c.profile,cityId,authorId,executorId,orders:[]};report.cases.push(entry);save();
    try{
      const[input]=await db.insert(schema.profileSourceInputs).values({userId:executorId,inputType:"text",rawText:c.profile,status:"confirmed"}).returning();entry.inputId=input.id;
      const p=await handleProfileExtraction(job({userId:executorId,sourceInputId:input.id}));entry.profileId=p.profileId;
      await db.update(schema.capabilityProfiles).set({status:"applied"}).where(eq(schema.capabilityProfiles.id,p.profileId));
      const profileDoc=await document({profileId:p.profileId});entry.normalizedProfile=present(profileDoc);
      for(let i=0;i<c.orders.length;i++){
        active=c.id+(c.orders.length>1?String.fromCharCode(65+i):"");
        const oentry={source:c.orders[i],expected:c.expected[i]};entry.orders.push(oentry);
        const[o]=await db.insert(schema.orders).values({authorId,cityId,sourceText:c.orders[i],status:"processing"}).returning();oentry.orderId=o.id;save();
        try{
          await handleOrderExtraction(job({orderId:o.id}));
          const stored=await db.query.orders.findFirst({where:eq(schema.orders.id,o.id)});
          const orderDoc=await document({orderId:o.id});oentry.normalizedOrder=present(orderDoc);
          oentry.riskLevel=stored.riskLevel;oentry.moderation=stored.moderationStatus;
          oentry.documentSimilarity=cosine(profileDoc.d.embedding,orderDoc.d.embedding);
          oentry.phraseSimilarities=orderDoc.facts.filter(f=>f.kind==="capability").map(r=>({requirement:r.phrase,profileFacts:profileDoc.facts.map(f=>({kind:f.kind,phrase:f.phrase,similarity:cosine(f.embedding,r.embedding)}))}));
          if(!["allow","allow_with_warning"].includes(stored.moderationStatus)) {
            const relations=await db.select().from(schema.ontologyRelations);
            for(const n of nodes) if(n.parentId) relations.push({fromNodeId:n.id,toNodeId:n.parentId,relationType:"is_a"});
            const diagnostic=evaluateSemantic({capabilities:profileDoc.facts.map(f=>({...f,confidence:Number(f.confidence)})),requirements:orderDoc.facts.map(f=>({...f,confidence:Number(f.confidence)})),relations,documentSimilarity:oentry.documentSimilarity,riskLevel:stored.riskLevel,regulated:orderDoc.facts.some(f=>f.nodeIds.some(id=>nodes.find(n=>n.id===id)?.regulated))});
            Object.assign(oentry,{finalDecision:"reject",finalScore:0,internalMatchType:"reject",trace:diagnostic.trace,diagnosticOnly:true,expectationPassed:c.expected[i]==="reject"});save();continue;
          }
          await db.update(schema.orders).set({status:"published"}).where(eq(schema.orders.id,o.id));
          Object.assign(oentry,await match(o.id,executorId));
          oentry.expectationPassed=c.expected[i]==="inspect"?null:oentry.finalDecision===c.expected[i];
          console.log(`LIVE_CASE_RESULT ${active} ${oentry.internalMatchType} score=${oentry.finalScore} similarity=${oentry.documentSimilarity.toFixed(4)}`);save();
        }catch(error){oentry.error={name:error.name,status:error.status??null};console.log(`LIVE_CASE_ERROR ${active} ${error.name}`);save();}
      }
    }catch(error){entry.error={name:error.name,status:error.status??null};console.log(`LIVE_PROFILE_ERROR ${active} ${error.name}`);save();}
  }
  const first=report.cases.find(c=>c.profileId&&c.orders.some(o=>o.run));
  if(first){
    active="idempotency";
    const before=await fingerprint(first.profileId);
    const again=await handleProfileExtraction(job({userId:first.executorId,sourceInputId:first.inputId}));
    const reprocessed=await reprocessProfile(first.profileId,undefined,true);
    const after=await fingerprint(first.profileId);
    const oid=first.orders.find(o=>o.run).orderId;
    const countsBefore=await db.execute(sql`SELECT count(*)::int total FROM matching_candidates mc JOIN matching_runs mr ON mr.id=mc.matching_run_id WHERE mr.order_id=${oid} AND mc.user_id=${first.executorId}`);
    const runs=await Promise.all([match(oid,first.executorId),match(oid,first.executorId)]);
    const countsAfter=await db.execute(sql`SELECT count(*)::int total FROM matching_candidates mc JOIN matching_runs mr ON mr.id=mc.matching_run_id WHERE mr.order_id=${oid} AND mc.user_id=${first.executorId}`);
    const duplicates=await db.execute(sql`SELECT matching_run_id,user_id,count(*)::int n FROM matching_candidates GROUP BY matching_run_id,user_id HAVING count(*)>1`);
    report.extra.idempotency={before,after,repeatProfileId:again.profileId,reprocessed,unchanged:before.contentHash===after.contentHash,rematchBefore:countsBefore,rematchAfter:countsAfter,rematchRuns:runs.map(r=>r.run),duplicateRowsWithinRun:duplicates};save();
  }
  const sixth=report.cases.find(c=>c.id==="6"&&c.profileId&&c.orders[0]?.run);
  if(sixth){
    active="controlled_no_canonical";
    const cityId=await fixtureCity(active),authorId=await user(cityId),executorId=await user(cityId);
    const sourceP=await document({profileId:sixth.profileId}),sourceO=await document({orderId:sixth.orders[0].orderId});
    const[p]=await db.insert(schema.capabilityProfiles).values({userId:executorId,summary:sixth.sourceProfile,profileVersion:1,status:"applied",extractionVersion:"live-vector-no-canonical-control"}).returning();
    const[o]=await db.insert(schema.orders).values({authorId,cityId,sourceText:sixth.orders[0].source,status:"published"}).returning();
    const prepared=({d,facts})=>({sourceText:d.sourceText,sourceHash:d.sourceHash,processingVersion:d.processingVersion+":nomap",embeddingModel:d.embeddingModel,embedding:d.embedding,facts:facts.map(f=>({...f,nodeIds:[],canonicalKeys:[],confidence:Number(f.confidence)}))});
    await db.transaction(async tx=>{await persistDocument(tx,{profileId:p.id},prepared(sourceP));await persistDocument(tx,{orderId:o.id},prepared(sourceO));await tx.insert(schema.profileEmbeddings).values({capabilityProfileId:p.id,embedding:sourceP.d.embedding,embeddingModel:sourceP.d.embeddingModel});});
    report.extra.noCanonical={note:"Controlled local test: unchanged LIVE vectors/facts from case 6, canonical IDs deliberately removed in separate fixture clones",orderId:o.id,profileId:p.id,executorId,result:await match(o.id,executorId)};save();
  }
  report.finishedAt=new Date().toISOString();save();console.log(`LIVE_REPORT ${output}`);
}finally{await getSql().end();}
