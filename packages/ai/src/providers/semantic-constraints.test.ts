import { describe, expect, it, vi } from "vitest";
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

// Stage 0 career context (2026-09-27): job-search statements must not become hard filters of service orders.
it("review prompt separates career context from service scope, location and refusals",async()=>{
  create.mockResolvedValue(response({hardConflict:null,compatible:true,confidence:0.9,reason:"ok"}));
  await openAiExtraction.reviewSemantic({profile:["Есть Газель"],order:["Перевезти диван"]},meta);
  const prompt=create.mock.lastCall![0].messages[0].content;
  expect(prompt).toContain("CAREER CONTEXT: statements about the person's own job search");
  expect(prompt).toContain("inventory exclusiveScope with requested=null");
  expect(prompt).toContain("refusing to relocate or travel says nothing about the local service area");
});
it("a job-search 'только' inventoried with requested=null keeps an ordinary side job (P12)",async()=>{
  const profile="Могу покрасить стены. Рассматриваю только позиции арт-директора или креативного директора от 400 тысяч.";
  const order="Покрасить деревянный забор на даче, около 20 метров.";
  create.mockResolvedValue(response({hardConflict:null,compatible:true,confidence:0.9,reason:"покраска",
    exclusiveScope:{profileEvidence:"Рассматриваю только позиции арт-директора или креативного директора от 400 тысяч.",orderEvidence:order,
      allowed:["позиции арт-директора","креативного директора"],requested:null,requestedWithinAllowed:false}}));
  const result=await openAiExtraction.reviewSemantic({profile:[profile],order:[order]},meta);
  expect(result.data).toMatchObject({compatible:true,hardConflict:null});
});
it("a grounded multi-sentence quote next to an unrelated salary sentence no longer crashes the review (P01)",async()=>{
  const profile="Бывший директор производства, управлял 300 сотрудниками. Есть Газель, права B/C, умею работать инструментом. Рассматриваю руководящие позиции от 500 тыс.";
  create.mockResolvedValue(response({compatible:false,confidence:0.9,reason:"другая сфера",
    hardConflict:{kind:"domain",profileEvidence:"Бывший директор производства, управлял 300 сотрудниками. Есть Газель, права B/C, умею работать инструментом.",orderEvidence:"Сделать маникюр на дому."}}));
  const result=await openAiExtraction.reviewSemantic({profile:[profile],order:["Сделать маникюр на дому."]},meta);
  expect(result.data.hardConflict?.kind).toBe("domain");
});
it("normalization prompt and schema type career context separately from service constraints",async()=>{
  create.mockResolvedValue(response({facts:[]}));
  await openAiExtraction.normalizeMatching({kind:"profile",text:"Есть Газель. К переезду в другой город не готов.",extracted:{},ontology:[]},{...meta,operationType:"matching_normalization"});
  const call=create.mock.lastCall![0];
  const prompt=call.messages[0].content;
  expect(prompt).toContain("CAREER CONTEXT (profiles)");
  expect(prompt).toContain("never maps to a moving, delivery or transport service node");
  expect(JSON.stringify(call.response_format.json_schema)).toContain("career_context");
});

// Bug 1 (2026-09-27): exclusion conflicts get a focused "does the order involve the refused thing?" check.
describe("refusal verification in reviewSemantic",()=>{
  const profile="Есть Газель, права B/C, умею работать инструментом. Не выполняю перевозки.";
  const mount="Собрать и повесить кухонные шкафы, просверлить отверстия в бетонной стене, нужен свой инструмент.";
  const move="Нужно перевезти диван и холодильник на Газели.";
  const excl=(order:string)=>response({compatible:false,confidence:0.9,reason:"отказ",hardConflict:{kind:"exclusion",profileEvidence:"Не выполняю перевозки.",orderEvidence:order}});
  it("V4 live pattern: refusal of transport does not reject furniture assembly",async()=>{
    create.mockReset(); create.mockResolvedValueOnce(excl(mount)).mockResolvedValueOnce(response({involves:false,reason:"сборка, не перевозка"}));
    const r=await openAiExtraction.reviewSemantic({profile:[profile],order:[mount]},meta);
    expect(r.data).toMatchObject({compatible:true,hardConflict:null});
    expect(JSON.stringify(create.mock.lastCall![0].messages)).toContain("Не выполняю перевозки.");
  });
  it("the same refusal still rejects a transport order",async()=>{
    create.mockReset(); create.mockResolvedValueOnce(excl(move)).mockResolvedValueOnce(response({involves:true,reason:"перевозка"}));
    const r=await openAiExtraction.reviewSemantic({profile:[profile],order:[move]},meta);
    expect(r.data).toMatchObject({compatible:false,hardConflict:{kind:"exclusion"}});
  });
  it("a failing verification keeps the review's proven conflict (no silent unblock)",async()=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    create.mockReset(); create.mockResolvedValueOnce(excl(move)).mockRejectedValue(new Error("timeout"));
    const r=await openAiExtraction.reviewSemantic({profile:[profile],order:[move]},meta);
    log.mockRestore();
    expect(r.data).toMatchObject({compatible:false,hardConflict:{kind:"exclusion"}});
  });
  it("no extra call when there is no exclusion conflict",async()=>{
    create.mockReset(); create.mockResolvedValueOnce(response({compatible:true,confidence:0.9,reason:"ok",hardConflict:null}));
    await openAiExtraction.reviewSemantic({profile:[profile],order:[mount]},meta);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
