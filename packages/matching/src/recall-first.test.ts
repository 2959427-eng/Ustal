import { expect, it } from "vitest";
import { evaluateSemantic, type Fact } from "./semantic.js";
const fact = (kind: string, id: string, extra: Partial<Fact> = {}): Fact => ({ kind, phrase:id, nodeIds:[id], confidence:1, mandatory:false, embedding:[1,0], ...extra });
const run = (capabilities: Fact[], requirements: Fact[], extra: Partial<Parameters<typeof evaluateSemantic>[0]> = {}) => evaluateSemantic({ capabilities, requirements, relations:[], documentSimilarity:0.4, riskLevel:0, regulated:false, ...extra });
const yes = {compatible:true,confidence:0.95,reason:"Related experience; details to confirm"};
it("admits adjacent skills after source review without an exact specialization node", () => {
  expect(run([fact("capability","broad",{embedding:[0,1]})],[fact("capability","narrow")],{semanticReview:yes}).matchType).not.toBeNull();
});
it("qualification and license flags do not veto a relevant reviewed opportunity", () => {
  expect(run([fact("capability","work")],[fact("capability","work")],{riskLevel:1,regulated:true,reviewRequired:true,semanticReview:yes}).matchType).toBe("exact");
});
it("whole workload compatibility can pass through multiple batches without inflating asset capacity", () => {
  const available=fact("resource","van",{resourceRole:"available",resourceCapacity:{value:3,unit:"m3",kind:null}});
  const workload=fact("resource","workload",{resourceRole:"compatibility",resourceCapacity:{value:10,unit:"m3",kind:null}});
  expect(run([available],[workload],{semanticReview:yes}).matchType).not.toBeNull();
  expect(available.resourceCapacity?.value).toBe(3);
});
it.each(["iOS only / Android", "iOS refusal / iOS", "chemical refusal / chemical cleaning"])("source conflict beats exact ontology: %s", (reason) => {
  expect(run([fact("capability","shared")],[fact("capability","shared")],{semanticReview:{compatible:false,confidence:0.95,reason}}).reason).toBe("source_incompatibility");
});
it("resource-target refusal remains binding alongside a matching capability", () => {
  const exclusion=fact("exclude","chemical",{constraintScope:"whole_task",embedding:[0,1]});
  expect(run([fact("capability","cleaning"),exclusion],[fact("capability","cleaning"),fact("resource","chemical",{resourceRole:"provided_by_customer",embedding:[0,1]})],{semanticReview:yes}).reason).toBe("explicit_exclusion");
});
it("an open time bound cannot satisfy a full night shift even when hours are on capability facts", () => {
  const cap=fact("capability","cleaning",{startHour:null,endHour:17});
  const shift=fact("capability","cleaning",{startHour:22,endHour:6,constraintScope:"whole_task"});
  expect(run([cap],[shift],{semanticReview:yes}).reason).toBe("outside_availability");
  expect(run([cap],[{...shift,startHour:9,endHour:16}],{semanticReview:yes}).matchType).toBe("exact");
});
