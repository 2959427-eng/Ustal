import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { SEMANTIC_POLICY } from "@ustal/matching";
import { handleMatchingRun } from "./matching-run.js";
assertLocalTestDatabase();
const db=getDb(), users:string[]=[], cities:string[]=[], orders:string[]=[];
afterAll(async()=>{
  if(orders.length) await db.delete(schema.orders).where(inArray(schema.orders.id,orders));
  if(users.length) await db.delete(schema.users).where(inArray(schema.users.id,users));
  if(cities.length) await db.delete(schema.cities).where(inArray(schema.cities.id,cities));
  await getSql().end();
});
it.each(["resource-only", "exact-conflict", "exact-budget", "numeric", "domain", "scope"])("reviews source constraints without a capability-only admission requirement: %s",async(mode)=>{
  const [city]=await db.insert(schema.cities).values({name:"TEST_recall_"+randomUUID(),regionName:"TEST",federalDistrict:"TEST",timezone:"Asia/Vladivostok",isActive:false}).returning();cities.push(city!.id);
  const pair=await db.insert(schema.users).values([0,1].map(()=>({phone:randomUUID().slice(0,20),passwordHash:"test-only",status:"active" as const}))).returning();users.push(...pair.map(u=>u.id));
  await db.insert(schema.userProfiles).values(pair.map(u=>({userId:u.id,cityId:city!.id,name:"TEST",acceptedRulesAt:new Date(),acceptedPdnAt:new Date()})));
  const [profile]=await db.insert(schema.capabilityProfiles).values({userId:pair[1]!.id,summary:"TEST",profileVersion:1,extractionVersion:"test",status:"applied"}).returning();
  const [order]=await db.insert(schema.orders).values({authorId:pair[0]!.id,cityId:city!.id,sourceText:"Android work",status:"published",riskLevel:0}).returning();orders.push(order!.id);
  const activeNode=await db.query.ontologyNodes.findFirst({where:eq(schema.ontologyNodes.status,"active")});
  if(!activeNode) throw new Error("seed ontology required");
  const vector=Array.from({length:1536},()=>0.01), node=randomUUID();
  // Retrieval uses the embedding; facts deliberately have no canonical nodes.
  await db.insert(schema.profileEmbeddings).values({capabilityProfileId:profile!.id,embeddingModel:"test",embedding:vector});
  const docs=await db.insert(schema.matchingDocuments).values([
    {profileId:profile!.id,sourceText:"iOS only"},{orderId:order!.id,sourceText:"Android work"},
  ].map(v=>({...v,processingVersion:"test",sourceHash:node,embeddingModel:"test",embedding:vector}))).returning();
  await db.insert(schema.matchingFacts).values(docs.map((d,i)=>({documentId:d.id,kind:mode==="resource-only"?"resource":"capability",phrase:"TEST",evidence:d.sourceText,nodeIds:mode==="resource-only"?[]:[activeNode.id],confidence:"1",mandatory:false,resourceRole:mode==="resource-only"?(i===0?"available":"compatibility"):"none",embedding:vector})));
  const spy=vi.spyOn(mockProviders.extraction,"reviewSemantic").mockResolvedValue({data:{compatible:mode!=="exact-conflict",confidence:0.95,reason:"test source decision",...(["numeric","domain","scope"].includes(mode)?{hardConflict:{kind:mode as "numeric"|"domain"|"scope",profileEvidence:"iOS only",orderEvidence:"Android work"}}:{})},provider:"mock",model:"mock",latencyMs:0,tokensInput:0,tokensOutput:0});
  const limit=SEMANTIC_POLICY.reviewLimit;
  if(mode==="exact-budget") SEMANTIC_POLICY.reviewLimit=0;
  try{
    const result=await handleMatchingRun({id:randomUUID(),data:{orderId:order!.id}} as never);
    if(!("matchingRunId" in result)) throw new Error("missing run");
    const traces=await db.select().from(schema.matchingTraces).where(eq(schema.matchingTraces.matchingRunId,result.matchingRunId));
    expect(spy).toHaveBeenCalledTimes(mode==="exact-budget"?0:1);
    expect(result.candidatesCount).toBe(mode==="resource-only"?1:0);
    if(["numeric","domain","scope"].includes(mode)) expect(traces[0]?.detail).toMatchObject({reason:`${mode}_mismatch`,semantic_review:{compatible:true,hardConflict:{kind:mode}}});
    if(mode==="exact-budget") expect(traces[0]?.decision).toBe("deferred_review_budget");
    if(mode==="exact-conflict") expect(traces[0]?.detail).toMatchObject({reason:"source_incompatibility"});
  }finally{spy.mockRestore();SEMANTIC_POLICY.reviewLimit=limit;}
},30000);
