import { expect,it } from "vitest";
import { retainedExplicitCapabilities as retain } from "./profile-capability-fallback.js";
const extracted=(label:string,evidenceType="explicit")=>({capabilities:[{label,evidenceType,confidence:0.95}]});
it.each(["вайбкодер","нейросценограф"])("retains %s when normalization drops the ability",text=>{
  expect(retain(text,extracted(text),[])).toMatchObject([{kind:"capability",phrase:text,evidence:text,nodeIds:[]}]);
});
it("does not invent a phrase absent from source or an inferred ability",()=>{
  expect(retain("есть дрель",extracted("строитель"),[])).toEqual([]);
  expect(retain("вайбкодер",extracted("вайбкодер","inferred"),[])).toEqual([]);
});
it("preserves explicit negatives, career context and already normalized capabilities",()=>{
  for(const f of [{kind:"exclude"},{kind:"availability",subjectType:"career_context"},{kind:"capability",constraintType:"none"}])
    expect(retain("вайбкодер",extracted("вайбкодер"),[f])).toEqual([]);
});
it("a physical resource extraction does not become a capability",()=>{
  expect(retain("есть самолёт",{capabilities:[],resources:[{label:"самолёт"}]},[{kind:"resource"}])).toEqual([]);
  expect(retain("есть самолёт",extracted("самолёт"),[{kind:"resource",subjectType:"physical_resource",phrase:"самолёт"}])).toEqual([]);
});
