import { expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";
const f=(kind:string,id:string,extra:Partial<Fact>={}):Fact=>({kind,phrase:id,nodeIds:[id],confidence:1,mandatory:false,embedding:[1,0],...extra});
const positive={compatible:true,confidence:0.7,reason:"Related skill; details to confirm"};
const run=(caps:Fact[],reqs:Fact[],extra:Partial<Parameters<typeof evaluateSemantic>[0]>={})=>evaluateSemantic({capabilities:caps,requirements:reqs,relations:[],documentSimilarity:0.2,riskLevel:0,regulated:false,semanticReview:positive,...extra});
it("positive review resolves semantic-only without a second confidence admission test",()=>{
  expect(run([f("capability","a",{embedding:[0,1]})],[f("capability","b")]).matchType).toBe("probable");
});
it("positive review resolves weak ontology overlap",()=>{
  expect(run([f("capability","a")],[f("capability","a"),f("capability","b")]).matchType).not.toBeNull();
});
it("positive review resolves qualification and physical review without rechecking certainty",()=>{
  expect(run([f("capability","a")],[f("capability","a"),f("resource","workload",{resourceRole:"compatibility"})],{riskLevel:1,reviewRequired:true,regulated:true}).matchType).toBe("exact");
});
it("positive review never overrides a missing mandatory owned resource",()=>{
  expect(run([f("capability","a")],[f("capability","a"),f("resource","vehicle",{mandatory:true,resourceRole:"required"})]).reason).toBe("missing_mandatory_resource");
});
it("positive review never overrides a targeted refusal or time restriction",()=>{
  expect(run([f("capability","a"),f("exclude","a",{constraintScope:"whole_task"})],[f("capability","a")]).reason).toBe("explicit_exclusion");
  expect(run([f("capability","a",{endHour:17})],[f("capability","a",{startHour:22,endHour:6,constraintScope:"whole_task"})]).reason).toBe("outside_availability");
});
it.each(["scope","location","eligibility","resource","exclusion","numeric","domain"])("source %s conflict beats even a positive review and exact/probable match",kind=>{
  for(const reqs of [[f("capability","a")],[f("capability","a"),f("capability","b")]])
    expect(run([f("capability","a")],reqs,{semanticReview:{...positive,hardConflict:{kind,profileEvidence:"explicit limit",orderEvidence:"conflicting requirement"}}}).reason).toBe(`${kind}_mismatch`);
});
