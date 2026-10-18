import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase,getDb,getSql,schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { prepareDocument,persistDocument } from "./semantic.js";
assertLocalTestDatabase();
const db=getDb(),users:string[]=[];
afterAll(async()=>{if(users.length)await db.delete(schema.users).where(inArray(schema.users.id,users));await getSql().end();});
it.each([
  ["вайбкодер",[],"capability"], ["таксую",["driving"],"capability"], ["репетитор",["teaching"],"capability"],
  ["сижу с детьми",["childcare"],"capability"], ["сижу с детьми",[],"capability"], ["нейросценограф",[],"capability"],
  ["кофемашина",[],"resource"],
])('%s retains source, phrase, embedding and compatible mapping',async(text,keys,kind)=>{
  const spy=vi.spyOn(mockProviders.extraction,"normalizeMatching").mockResolvedValue({data:{facts:[{kind,subjectType:kind==="resource"?"physical_resource":"unspecified",phrase:text,evidence:text,canonicalKeys:keys,confidence:0.95,mandatory:false,constraintType:"none",constraintScope:"whole_task",resourceRole:kind==="resource"?"available":"none",resourceCapacity:{value:null,unit:null,kind:null},startHour:null,endHour:null,daysOfWeek:null,refusalIntent:null}]},provider:"mock",model:"mock",tokensInput:0,tokensOutput:0,latencyMs:0} as never);
  try{
    const doc=await prepareDocument("profile",text,{},randomUUID());
    const [u]=await db.insert(schema.users).values({phone:randomUUID().slice(0,20),passwordHash:"qa-local"}).returning();users.push(u!.id);
    const saved=await db.transaction(async tx=>{
      const [p]=await tx.insert(schema.capabilityProfiles).values({userId:u!.id,summary:text,profileVersion:1,extractionVersion:doc.processingVersion,status:"draft"}).returning();
      return persistDocument(tx,{profileId:p!.id},doc);
    });
    const facts=await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId,saved.id));
    expect(facts).toHaveLength(1);expect(facts[0]).toMatchObject({kind,phrase:text,evidence:text});
    expect(facts[0]!.embedding).toHaveLength(1536);expect(doc.sourceText).toBe(text);
    if(!(keys as string[]).length)expect(facts[0]!.nodeIds).toEqual([]);
    else {const nodes=await db.select().from(schema.ontologyNodes).where(inArray(schema.ontologyNodes.id,facts[0]!.nodeIds));expect(nodes.map(n=>n.canonicalKey)).toEqual(expect.arrayContaining(keys as string[]));if(text==="репетитор")expect(nodes.every(n=>["teaching","tutoring_school"].includes(n.canonicalKey))).toBe(true);}
  }finally{spy.mockRestore();}
});
it.each(["вайбкодер","нейросценограф"])("%s survives even when normalization returns no facts",async(text)=>{
  const spy=vi.spyOn(mockProviders.extraction,"normalizeMatching").mockResolvedValue({data:{facts:[]},provider:"mock",model:"mock",tokensInput:0,tokensOutput:0,latencyMs:0} as never);
  try{
    const doc=await prepareDocument("profile",text,{capabilities:[{label:text,evidenceType:"explicit",confidence:0.95}]},randomUUID());
    expect(doc.facts).toHaveLength(1);expect(doc.facts[0]).toMatchObject({kind:"capability",phrase:text,evidence:text,nodeIds:[]});
    expect(doc.facts[0]!.embedding).toHaveLength(1536);expect(doc.sourceText).toBe(text);
  }finally{spy.mockRestore();}
});
it("an explicit occupation is retained if an erroneous ownership role retyped it as a resource",async()=>{
  const text="нейросценограф";
  const spy=vi.spyOn(mockProviders.extraction,"normalizeMatching").mockResolvedValue({data:{facts:[{kind:"capability",subjectType:"unspecified",phrase:text,evidence:text,canonicalKeys:[],confidence:0.9,mandatory:false,constraintType:"none",constraintScope:"whole_task",resourceRole:"available",resourceCapacity:{value:null,unit:null,kind:null},startHour:null,endHour:null,daysOfWeek:null,refusalIntent:null}]},provider:"mock",model:"mock",tokensInput:0,tokensOutput:0,latencyMs:0} as never);
  try{const doc=await prepareDocument("profile",text,{capabilities:[{label:text,evidenceType:"explicit",confidence:0.95}]},randomUUID());expect(doc.facts.some(f=>f.kind==="capability"&&f.phrase===text&&f.embedding.length===1536)).toBe(true);}
  finally{spy.mockRestore();}
});
