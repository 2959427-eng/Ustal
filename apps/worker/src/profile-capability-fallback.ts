/** Retain a literal, explicitly extracted ability if normalization omitted all
 * positive abilities. No ontology guessing, word dictionary or inferred skills.
 */
export function retainedExplicitCapabilities(text: string, extracted: unknown, facts: { kind: string; phrase?: string; constraintType?: string; subjectType?: string }[]) {
  if (facts.some(f => f.kind === "capability" && f.constraintType !== "exclusion") ||
      facts.some(f => f.kind === "exclude" || f.constraintType === "exclusion" || f.subjectType === "career_context")) return [];
  const caps=(extracted as {capabilities?: {label?:string;evidenceType?:string;confidence?:number}[]}|null)?.capabilities;
  if (!Array.isArray(caps)) return [];
  return caps.flatMap(c => {
    const label=c.label?.trim();
    if (!label || c.evidenceType!=="explicit" || (c.confidence??0)<0.85) return [];
    if (facts.some(f=>f.kind==="resource" && f.subjectType==="physical_resource" && f.phrase?.trim().toLowerCase()===label.toLowerCase())) return [];
    const at=text.toLowerCase().indexOf(label.toLowerCase());
    if (at<0) return [];
    const literal=text.slice(at,at+label.length);
    return [{kind:"capability" as const,subjectType:"unspecified" as const,phrase:literal,evidence:literal,canonicalKeys:[],nodeIds:[],confidence:c.confidence!,mandatory:false,constraintType:"none" as const,constraintScope:"whole_task" as const,resourceRole:"none" as const,resourceCapacity:{value:null,unit:null,kind:null},startHour:null,endHour:null,daysOfWeek:null,refusalIntent:null}];
  });
}
