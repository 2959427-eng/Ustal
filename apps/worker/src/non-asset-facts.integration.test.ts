import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import { mockProviders } from "@ustal/ai";
import { prepareDocument } from "./semantic.js";
assertLocalTestDatabase();
afterAll(async()=>{await getSql().end();});
it.each(["software_skill","qualification"] as const)("does not turn %s into an asset even when AI maps it to a resource ontology node",async(subjectType)=>{
  const node=await getDb().query.ontologyNodes.findFirst({where:eq(schema.ontologyNodes.canonicalKey,"tool_use")});
  expect(node?.nodeType).toBe("resource");
  const text=subjectType==="software_skill"?"Work using a spreadsheet application":"Driving permit category";
  const spy=vi.spyOn(mockProviders.extraction,"normalizeMatching").mockResolvedValue({
    data:{facts:[{kind:"resource",subjectType,phrase:text,evidence:text,canonicalKeys:["tool_use"],confidence:1,mandatory:true,constraintType:"none",constraintScope:"whole_task",resourceRole:"compatibility",resourceCapacity:{value:3,unit:"category",kind:"license"},startHour:null,endHour:null,daysOfWeek:null}]},
    provider:"mock",model:"mock",tokensInput:0,tokensOutput:0,latencyMs:0,
  });
  try{
    const doc=await prepareDocument("order",text,{},randomUUID());
    expect(doc.facts).toHaveLength(1);
    expect(doc.facts[0]).toMatchObject({kind:"capability",mandatory:false,resourceRole:"none",resourceCapacity:{value:null,unit:null,kind:null},nodeIds:[]});
  }finally{spy.mockRestore();}
});
