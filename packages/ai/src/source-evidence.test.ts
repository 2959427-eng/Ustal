import {expect,it} from "vitest";
import {sourceEvidenceSpans} from "./source-evidence.js";
it("preserves coordinated statements, punctuation, capitalization and negation verbatim", () => {
  const source="Занимаюсь растениями: поливаю, подрезаю; пересадку НЕ предлагаю.\nЕсть лейка.";
  expect(sourceEvidenceSpans(source)).toEqual([source]);
});
it("covers a long source without dropping, inventing or breaking Unicode characters", () => {
  const source=("🌿".repeat(600)+"\nУточнение: " + "растения ".repeat(200));
  const spans=sourceEvidenceSpans(source);
  expect(spans.join("")).toBe(source);
  expect(spans.every(s=>s.length>0&&s.length<=1000&&source.includes(s))).toBe(true);
  expect(spans.every(s=>!/[\uD800-\uDBFF]$/.test(s)&&!/^([\uDC00-\uDFFF])/.test(s))).toBe(true);
});
it("does not fabricate evidence for an empty source",()=>{
  expect(()=>sourceEvidenceSpans("")).toThrow("nonempty");
});
