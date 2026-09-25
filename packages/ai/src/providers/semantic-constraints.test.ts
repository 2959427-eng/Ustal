import { expect, it, vi } from "vitest";
const {create}=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("@ustal/config",()=>({loadEnv:()=>({OPENAI_API_KEY:"test",AI_MODEL_SEMANTIC_REVIEW:"review-test"})}));
vi.mock("openai",()=>({default:class{chat={completions:{create}};},toFile:vi.fn()}));
import { openAiExtraction } from "./openai.js";
const meta={operationType:"semantic_pair_review",traceId:"test",promptVersion:"test",schemaVersion:"v1"};
const response=(data:unknown)=>({choices:[{message:{content:JSON.stringify(data)}}]});
it.each([
  {kind:"scope",profile:"Android only",order:"iOS application"},
  {kind:"location",profile:"City Alpha",order:"City Beta"},
  {kind:"domain",profile:"учитель истории",order:"репетитор по математике"},
] as const)("preserves a grounded $kind hard conflict even when the model also claims positive relevance",async({kind,profile,order})=>{
  create.mockResolvedValue(response({hardConflict:{kind,profileEvidence:profile,orderEvidence:order},compatible:true,confidence:0.7,reason:"shared skill"}));
  const result=await openAiExtraction.reviewSemantic({profile:[profile],order:[order]},meta);
  expect(result.data.compatible).toBe(false);
  expect(result.data.hardConflict?.kind).toBe(kind);
  const contract=create.mock.lastCall![0].response_format.json_schema;
  expect(contract.required??contract.schema.required).toContain("hardConflict");
});
it("rejects invented source evidence, instead of publishing an invented location mismatch",async()=>{
  create.mockResolvedValue(response({hardConflict:{kind:"location",profileEvidence:"invented",orderEvidence:"City Beta"},compatible:false,confidence:1,reason:"conflict"}));
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{await expect(openAiExtraction.reviewSemantic({profile:["City Alpha"],order:["City Beta"]},meta)).rejects.toThrow();}finally{log.mockRestore();}
});
it("transfers ordinary care experience while keeping medical procedures and explicit scope separate",async()=>{
  create.mockResolvedValue(response({hardConflict:null,compatible:true,confidence:0.7,reason:"Transferable care"}));
  const result=await openAiExtraction.reviewSemantic({profile:["Care experience"],order:["Related care"]},meta);
  const prompt=create.mock.lastCall![0].messages[0].content;
  expect(prompt).toContain("A stated age group or patient type is experience");
  expect(prompt).toContain("distinguish explicit\nmedical procedures");
  expect(prompt).toContain("Never invent a remote format");
  expect(prompt).toContain("generic pedagogy does not establish knowledge of a different");
  expect(result.data).toMatchObject({compatible:true,confidence:0.7,hardConflict:null});
});
