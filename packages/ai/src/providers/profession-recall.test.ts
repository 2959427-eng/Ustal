import { beforeEach, expect, it, vi } from "vitest";
const { create }=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("@ustal/config",()=>({loadEnv:()=>({OPENAI_API_KEY:"test-only",AI_MODEL_NORMALIZATION:"fixture"})}));
vi.mock("openai",()=>({default:class{chat={completions:{create}};},toFile:vi.fn()}));
import { openAiExtraction } from "./openai.js";
const meta={operationType:"qa10",traceId:"test",promptVersion:"v1",schemaVersion:"v1"};
const node=(canonicalKey:string,nodeType="capability")=>({canonicalKey,nodeType,name:canonicalKey,description:null,synonyms:[]});
const fact=(phrase:string,canonicalKeys:string[]=[],extra:Record<string,unknown>={})=>({kind:"capability",subjectType:"unspecified",phrase,evidence:"source_0",canonicalKeys,confidence:0.95,mandatory:false,constraintType:"none",constraintScope:"whole_task",resourceRole:"none",resourceCapacity:{value:null,unit:null,kind:null},startHour:null,endHour:null,daysOfWeek:null,refusalIntent:null,...extra});
const response=(facts:unknown[])=>({choices:[{message:{content:JSON.stringify({facts})}}]});
beforeEach(()=>create.mockReset());
it.each(["вайбкодер","нейросценограф"])('%s remains a literal capability with no invented node',async(text)=>{
  create.mockResolvedValue(response([fact(text)]));
  const r=await openAiExtraction.normalizeMatching({kind:"profile",text,extracted:{},ontology:[node("teaching")]},meta);
  expect(r.data.facts[0]).toMatchObject({kind:"capability",phrase:text,evidence:text,canonicalKeys:[]});
});
it("a risk catalogue binding is repaired to a genuine driving capability, preserving the fact",async()=>{
  create.mockResolvedValueOnce(response([fact("таксую",["passenger_transport"])]))
    .mockResolvedValueOnce(response([fact("таксую",["driving"])]));
  const r=await openAiExtraction.normalizeMatching({kind:"profile",text:"таксую",extracted:{},ontology:[node("passenger_transport","risk"),node("driving")]},meta);
  expect(r.data.facts[0]).toMatchObject({kind:"capability",canonicalKeys:["driving"],evidence:"таксую"});
  expect(r.validationAttempts).toBe(2);
});
it("an uncertain mapping repairs to [] without losing the capability",async()=>{
  create.mockResolvedValueOnce(response([fact("новая профессия",["hazard"])]))
    .mockResolvedValueOnce(response([fact("новая профессия")]));
  const r=await openAiExtraction.normalizeMatching({kind:"profile",text:"новая профессия",extracted:{},ontology:[node("hazard","risk")]},meta);
  expect(r.data.facts[0]).toMatchObject({kind:"capability",canonicalKeys:[]});
});
it("persistently uncertain risk mapping preserves the capability after bounded repair",async()=>{
  create.mockResolvedValue(response([fact("новая профессия",["hazard"])]));
  const r=await openAiExtraction.normalizeMatching({kind:"profile",text:"новая профессия",extracted:{},ontology:[node("hazard","risk")]},meta);
  expect(r.data.facts[0]).toMatchObject({kind:"capability",phrase:"новая профессия",evidence:"новая профессия",canonicalKeys:[]});
  expect(r.validationAttempts).toBe(3);
});
it.each([["репетитор","teaching"],["сижу с детьми","childcare"]])('%s uses an existing relevant node',async(text,key)=>{
  create.mockResolvedValue(response([fact(text,[key])]));
  const r=await openAiExtraction.normalizeMatching({kind:"profile",text,extracted:{},ontology:[node(key)]},meta);
  expect(r.data.facts[0]).toMatchObject({kind:"capability",canonicalKeys:[key],evidence:text});
});
it("a physical object stays a resource",async()=>{
  create.mockResolvedValue(response([fact("кофемашина",[],{kind:"resource",subjectType:"physical_resource",resourceRole:"available"})]));
  const r=await openAiExtraction.normalizeMatching({kind:"profile",text:"кофемашина",extracted:{},ontology:[]},meta);
  expect(r.data.facts[0]?.kind).toBe("resource");
});
it("an explicit hazardous-work refusal retains its risk binding and exclusion",async()=>{
  create.mockResolvedValue(response([fact("работа на высоте",["height_work"],{kind:"exclude",constraintType:"exclusion",refusalIntent:"restriction"})]));
  const r=await openAiExtraction.normalizeMatching({kind:"profile",text:"работа на высоте",extracted:{},ontology:[node("height_work","risk")]},meta);
  expect(r.data.facts[0]).toMatchObject({kind:"exclude",constraintType:"exclusion",canonicalKeys:["height_work"]});
});
