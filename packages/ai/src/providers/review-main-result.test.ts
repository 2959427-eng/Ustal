import {beforeEach, expect, it, vi} from "vitest";
const {create, plan}=vi.hoisted(()=>({create:vi.fn(),plan:{primary:{} as any,action:null as string|null,assessment:{} as any,boundary:{} as any,refusal:{involves:true,reason:"Requested refused activity"}}}));
vi.mock("@ustal/config",()=>({loadEnv:()=>({OPENAI_API_KEY:"test",AI_MODEL_SEMANTIC_REVIEW:"review-test"})}));
vi.mock("openai",()=>({default:class{chat={completions:{create}};},toFile:vi.fn()}));
import {openAiExtraction} from "./openai.js";
const meta={operationType:"semantic_pair_review",traceId:"test",promptVersion:"test",schemaVersion:"v1"};
const run=(profile:string,order:string)=>openAiExtraction.reviewSemantic({profile:[profile],order:[order]},meta);
beforeEach(()=>{
 create.mockReset();
 plan.primary={compatible:true,confidence:0.9,reason:"Related opportunity",hardConflict:null,numericLimits:[],exclusiveScope:null};
 plan.action=null;plan.refusal={involves:true,reason:"Requested refused activity"};
 plan.boundary={careerOnly:false,scopeConflict:false,requested:null,reason:"No outside service scope requested"};
 create.mockImplementation(async(request:any)=>{
  const name=request.response_format.json_schema.name;
  const data=name==="semantic_review_v1"?plan.primary:name==="source_action_verb_v1"?{actionVerbEvidence:plan.action}:name==="main_result_verification_v1"?plan.assessment:name==="refusal_target_v1"?plan.refusal:name==="scope_boundary_verification_v1"?plan.boundary:undefined;
  if(data===undefined)throw Error("Unexpected model operation: "+name);
  return {choices:[{message:{content:JSON.stringify(data)}}]};
 });
});
function concrete(profile:string,order:string,verb:string,overrides:Record<string,unknown>={}){
 plan.action=verb;
 plan.assessment={compatible:true,confidence:0.9,reason:"Transferable primary activity",onlySubstep:false,differentCoreOperation:false,sharedFieldOnly:false,unrelatedSpecialistDomain:false,specialistDomainEvidence:null,concreteActivityEvidence:true,broadRoleEvidence:null,profileEvidence:profile,orderEvidence:order,profileOperation:"operate",orderOperation:"operate",...overrides};
}
it("keeps the established primary wire contract and public profile/review shape",async()=>{
 const result=await run("Профессия мастера","Смежная задача");
 const primary=create.mock.calls[0]![0];
 expect(primary.response_format.json_schema.name).toBe("semantic_review_v1");
 expect(primary.response_format.json_schema.schema.properties).not.toHaveProperty("actionVerbEvidence");
 expect(primary.messages[0].content).not.toContain("undertake or discuss");
 expect(result.data.compatible).toBe(true);
 expect(result.data).not.toHaveProperty("actionVerbEvidence");
 expect(result.data).not.toHaveProperty("mainResultAssessment");
});
it.each([
 ["Могу сверлить бетон","Нужно просверлить кирпичную стену","сверлить"],
 ["Могу сверлить бетон","Нужно сделать отверстия под полку","сверлить"],
 ["Могу сверлить бетон","Нужно поработать перфоратором","сверлить"],
 ["Ремонтирую стиральные машины","Нужен ремонт бытовой техники","Ремонтирую"],
 ["Укладываю ламинат","Нужны напольные покрытия","Укладываю"],
 ["Могу косить траву","Нужен уход за участком","косить"],
])("preserves a transferable main-result bridge: %s -> %s",async(profile,order,verb)=>{
 concrete(profile,order,verb);
 expect((await run(profile,order)).data.compatible).toBe(true);
 expect(create.mock.calls.map(c=>c[0].response_format.json_schema.name)).toEqual(["semantic_review_v1","source_action_verb_v1","main_result_verification_v1"]);
});
it.each([
 ["Могу сверлить бетон","Ремонт квартиры целиком","сверлить","multi_trade_project"],
 ["Меняю розетки","Проектирование электроснабжения завода","Меняю","design_plan"],
 ["Собираю шкафы","Изготовление резной мебели","Собираю","make_fabricate"],
 ["Крашу стены","Капитальный ремонт квартиры","Крашу","multi_trade_project"],
 ["Укладываю ламинат","Строительство дома под ключ","Укладываю","multi_trade_project"],
 ["Кошу траву","Проект ландшафтного дизайна парка","Кошу","design_plan"],
])("rejects a confirmed project/stage gap despite a broad positive verdict: %s",async(profile,order,verb,orderOperation)=>{
 concrete(profile,order,verb,{compatible:true,differentCoreOperation:true,onlySubstep:orderOperation==="multi_trade_project",orderOperation});
 expect((await run(profile,order)).data).toMatchObject({compatible:false,hardConflict:{kind:"domain"}});
});
it.each(["Плотник","Новая профессия нейромастер","Есть фургон, права и умею работать инструментом"])("does not narrow a broad role/resource/generic practical capability: %s",async profile=>{
 expect((await run(profile,"Обычная подходящая задача")).data.compatible).toBe(true);
 expect(create).toHaveBeenCalledTimes(2);
 expect(create.mock.calls.some(c=>c[0].response_format.json_schema.name==="main_result_verification_v1")).toBe(false);
});
it("preserves an explicitly stated related broader role",async()=>{
 const p="Я мастер. Могу сделать деталь",o="Изготовление изделия";
 concrete(p,o,"сделать",{compatible:false,broadRoleEvidence:"мастер",differentCoreOperation:true,profileOperation:"operate",orderOperation:"make_fabricate"});
 expect((await run(p,o)).data.compatible).toBe(true);
});
it("an invented broader role cannot erase a project gap",async()=>{
 const p="Могу сделать деталь",o="Выполнить комплексный проект";
 concrete(p,o,"сделать",{broadRoleEvidence:"строитель",onlySubstep:true,orderOperation:"multi_trade_project"});
 expect((await run(p,o)).data.compatible).toBe(false);
});
it("an invented specialist domain cannot reject ordinary adjacent installation",async()=>{
 const p="Могу сверлить бетон",o="Повесить полку";
 concrete(p,o,"сверлить",{unrelatedSpecialistDomain:true,specialistDomainEvidence:"промышленная инженерия",orderOperation:"assemble_install"});
 expect((await run(p,o)).data.compatible).toBe(true);
});
it("shared abstract operation labels cannot authorize a field-only bridge",async()=>{
 const p="Вожу фургон",o="Управлять башенным краном";
 concrete(p,o,"Вожу",{sharedFieldOnly:true});
 expect((await run(p,o)).data).toMatchObject({compatible:false,hardConflict:{kind:"domain"}});
});
it("a grounded specialist activity supplies primary-domain evidence",async()=>{
 const p="Вожу фургон",o="Управлять башенным краном";
 concrete(p,o,"Вожу",{unrelatedSpecialistDomain:true,specialistDomainEvidence:o});
 expect((await run(p,o)).data.compatible).toBe(false);
});
it("removing an invented refusal cannot bypass main-result verification",async()=>{
 const p="Меняю розетки",o="Проектирование электроснабжения завода";
 concrete(p,o,"Меняю",{differentCoreOperation:true,orderOperation:"design_plan"});
 plan.primary={...plan.primary,compatible:false,hardConflict:{kind:"exclusion",profileEvidence:p,orderEvidence:o}};
 plan.refusal={involves:false,reason:"Positive skill is not a refusal"};
 expect((await run(p,o)).data).toMatchObject({compatible:false,hardConflict:{kind:"domain"}});
 expect(create.mock.calls.map(c=>c[0].response_format.json_schema.name)).toEqual(["semantic_review_v1","refusal_target_v1","source_action_verb_v1","main_result_verification_v1"]);
});
it("preserves a genuine refusal without interpreting it as a positive concrete action",async()=>{
 const p="Не выполняю перевозки",o="Нужно выполнить перевозки";
 plan.primary={...plan.primary,compatible:false,hardConflict:{kind:"exclusion",profileEvidence:p,orderEvidence:o}};
 expect((await run(p,o)).data.compatible).toBe(false);
 expect(create).toHaveBeenCalledTimes(2);
});
it("preserves the existing exclusive-platform inventory",async()=>{
 const p="Разработка только iOS",o="Нужен Android";
 plan.primary={...plan.primary,compatible:false,hardConflict:{kind:"scope",profileEvidence:p,orderEvidence:o},exclusiveScope:{profileEvidence:p,orderEvidence:o,allowed:["iOS"],requested:"Android",requestedWithinAllowed:false}};
 plan.boundary={careerOnly:false,scopeConflict:true,requested:"Android",reason:"Exclusive platform is different"};
 expect((await run(p,o)).data).toMatchObject({compatible:false,hardConflict:{kind:"scope"}});
 expect(create).toHaveBeenCalledTimes(2);
});
it("an employment preference cannot reject an explicitly stated ordinary skill",async()=>{
 const p="Могу покрасить стены. Рассматриваю только руководящие позиции",o="Покрасить забор";
 concrete(p,o,"покрасить",{profileOperation:"apply_finish",orderOperation:"apply_finish"});
 plan.primary={...plan.primary,compatible:false,hardConflict:{kind:"scope",profileEvidence:p,orderEvidence:o},exclusiveScope:{profileEvidence:p,orderEvidence:o,allowed:["руководящие позиции"],requested:o,requestedWithinAllowed:false}};
 plan.boundary={careerOnly:true,scopeConflict:true,requested:o,reason:"Employment preference is not a service limit"};
 expect((await run(p,o)).data).toMatchObject({compatible:true,hardConflict:null,exclusiveScope:{requested:null}});
 const contract=create.mock.calls.find(c=>c[0].response_format.json_schema.name==="scope_boundary_verification_v1")![0].response_format;
 expect(JSON.stringify(contract)).not.toContain('"$ref"');
});
it("clearing a career scope preserves an independent numeric limit",async()=>{
 const p="Работаю 2 часа. Рассматриваю только руководящие позиции",o="Нужно работать 4 часа";
 plan.primary={...plan.primary,compatible:false,hardConflict:{kind:"scope",profileEvidence:p,orderEvidence:o},exclusiveScope:{profileEvidence:p,orderEvidence:o,allowed:["руководящие позиции"],requested:o,requestedWithinAllowed:false},numericLimits:[{profileEvidence:"Работаю 2 часа",orderEvidence:o,metric:"duration",available:2,required:4,availableUnit:"часа",requiredUnit:"часа",limitKind:"threshold",wholeTaskEvidence:null}]};
 plan.boundary={careerOnly:true,scopeConflict:false,requested:null,reason:"Employment preference only"};
 expect((await run(p,o)).data).toMatchObject({compatible:false,hardConflict:{kind:"numeric"}});
});
it("removing a false refusal re-applies a genuine exclusive service boundary",async()=>{
 const p="Разработка только iOS",o="Нужен Android";
 plan.primary={...plan.primary,compatible:false,hardConflict:{kind:"exclusion",profileEvidence:p,orderEvidence:o},exclusiveScope:{profileEvidence:p,orderEvidence:o,allowed:["iOS"],requested:null,requestedWithinAllowed:true}};
 plan.boundary={careerOnly:false,scopeConflict:true,requested:"Android",reason:"Outside the exclusive service platform"};
 plan.refusal={involves:false,reason:"An exclusive scope is not the quoted refusal target"};
 expect((await run(p,o)).data).toMatchObject({compatible:false,hardConflict:{kind:"scope"}});
});
it("a failed boundary verification preserves the primary proven conflict",async()=>{
 const p="Разработка только iOS",o="Нужен Android";
 plan.primary={...plan.primary,compatible:false,hardConflict:{kind:"scope",profileEvidence:p,orderEvidence:o},exclusiveScope:{profileEvidence:p,orderEvidence:o,allowed:["iOS"],requested:"Android",requestedWithinAllowed:false}};
 plan.boundary=undefined;
 const log=vi.spyOn(console,"error").mockImplementation(()=>{});
 try{expect((await run(p,o)).data).toMatchObject({compatible:false,hardConflict:{kind:"scope"}});}finally{log.mockRestore();}
});
it("a verifier-confirmed boundary cannot become positive by clearing the initial conflict",async()=>{
 const p="Не работаю с 3D",o="Нужно 3D";
 plan.primary={...plan.primary,compatible:false,hardConflict:{kind:"scope",profileEvidence:p,orderEvidence:o},exclusiveScope:{profileEvidence:p,orderEvidence:o,allowed:["3D"],requested:"3D",requestedWithinAllowed:false}};
 plan.boundary={careerOnly:false,scopeConflict:true,requested:"3D",reason:"Current service boundary is violated"};
 expect((await run(p,o)).data.compatible).toBe(false);
});
it("different labels alone cannot invent a gap when no operative difference was established",async()=>{
 const p="Умею работать инструментом",o="Обычные подготовка и выполнение задачи";
 concrete(p,o,"работать",{concreteActivityEvidence:false,differentCoreOperation:false,profileOperation:"operate",orderOperation:"multi_trade_project"});
 expect((await run(p,o)).data.compatible).toBe(true);
});
it("rejects invented action evidence using bounded source repair",async()=>{
 plan.action="несуществующий глагол";
 await expect(run("Профессия мастера","Обычная задача")).rejects.toThrow("Evidence");
 expect(create).toHaveBeenCalledTimes(4);
});

// Cache-key fix (2026-10-15): an ungrounded optional role/domain quote is still discarded exactly as before; the
// verdict is marked degraded (not memoized) only when that discard decides the main-result outcome.
it("marks degraded only when a discarded ungrounded role quote decides the outcome",async()=>{
 const profile="Мою полы в офисах",order="Нужна генеральная уборка квартиры";
 concrete(profile,order,"Мою",{sharedFieldOnly:true,broadRoleEvidence:"профессиональный клинер"});
 const decided=await run(profile,order);
 expect(decided.data).toMatchObject({compatible:false,hardConflict:{kind:"domain"}});
 expect(decided.degraded).toBe(true);
 concrete(profile,order,"Мою",{sharedFieldOnly:false,broadRoleEvidence:"профессиональный клинер"});
 const irrelevant=await run(profile,order);
 expect(irrelevant.data.compatible).toBe(true);
 expect(irrelevant.degraded).toBeUndefined();
 concrete(profile,order,"Мою",{sharedFieldOnly:true,broadRoleEvidence:null});
 const grounded=await run(profile,order);
 expect(grounded.data.compatible).toBe(false);
 expect(grounded.degraded).toBeUndefined();
});
it("marks degraded when a discarded ungrounded specialist-domain quote decides the outcome",async()=>{
 const profile="Ремонтирую стиральные машины",order="Нужен ремонт бытовой техники";
 concrete(profile,order,"Ремонтирую",{unrelatedSpecialistDomain:true,specialistDomainEvidence:"ядерная физика"});
 const decided=await run(profile,order);
 expect(decided.data.compatible).toBe(true);
 expect(decided.degraded).toBe(true);
});
