/** Declarative QA oracle, NOT an implementation of incremental profile merging.
 * No imports from production and no unavailable profileItems/removes API.
 * Every expected state is specified explicitly, independent of the AI response.
 */
export type ItemKind = "skill" | "resource" | "removed_skill" | "no_resource" | "time_limit" | "refusal";
export interface RemoveTarget { kind: ItemKind | "all"; key?: string }
export interface FactFixture {
  kind: "capability" | "resource" | "exclude" | "availability";
  phrase: string; canonicalKeys: string[]; evidence: string;
  subjectType: "unspecified" | "physical_resource";
  confidence: number; mandatory: boolean;
  constraintType: "none" | "exclusion" | "availability";
  constraintScope: "whole_task";
  resourceRole: "none" | "available" | "missing";
  resourceCapacity: { value: null; unit: null; kind: null };
  startHour: null; endHour: number | null; daysOfWeek: null;
  refusalIntent: "revoke" | "restriction" | null;
}
export interface ExpectedState {
  skills: string[]; resources: string[]; workRestrictions: string[];
  globalEndHours: number[]; revokedSkills: string[]; missingResources: string[];
  order23: "allowed" | "blocked" | "not_applicable";
}
export interface StepFixture {
  id: string; message: string; operation: string;
  ai: { facts: FactFixture[]; removes: RemoveTarget[] };
  expected: ExpectedState; invariants: string[];
}
export interface Scenario { id: string; defect: 4 | 5 | "4+5"; title: string; steps: StepFixture[] }

const names: Record<string, string> = { appliance_repair: "ремонт бытовой техники", digging: "копать", assembly: "сборка мебели",
  van: "газель", plane: "самолёт", refrigerator_repair: "ремонт холодильников", delivery: "доставка" };
export function fact(key: string, over: Partial<FactFixture> = {}): FactFixture {
  return { kind: "capability", phrase: names[key] ?? key, canonicalKeys: key === "plane" ? [] : [key], evidence: "",
    subjectType: "unspecified", confidence: 0.95, mandatory: false, constraintType: "none", constraintScope: "whole_task",
    resourceRole: "none", resourceCapacity: { value: null, unit: null, kind: null }, startHour: null, endHour: null,
    daysOfWeek: null, refusalIntent: null, ...over };
}
const skill = (key: string) => fact(key);
const resource = (key: string, missing = false) => fact(key, { kind: "resource", subjectType: "physical_resource", resourceRole: missing ? "missing" : "available" });
const revoke = (key: string) => fact(key, { kind: "exclude", constraintType: "exclusion", refusalIntent: "revoke" });
const restriction = (key: string) => fact(key, { kind: "exclude", constraintType: "exclusion", refusalIntent: "restriction" });
const time = (hour: number) => fact("", { kind: "availability", phrase: `работаю до ${hour}:00`, canonicalKeys: [], constraintType: "availability", endHour: hour });
const target = (kind: ItemKind | "all", key?: string): RemoveTarget => ({ kind, ...(key ? { key } : {}) });
const state = (skills: string[], resources: string[] = [], workRestrictions: string[] = [], globalEndHours: number[] = [], revokedSkills: string[] = [], missingResources: string[] = []): ExpectedState => ({
  skills, resources, workRestrictions, globalEndHours, revokedSkills, missingResources,
  order23: !skills.includes("digging") ? "not_applicable" : globalEndHours.length ? "blocked" : "allowed",
});
function step(id: string, message: string, operation: string, facts: FactFixture[], removes: RemoveTarget[], expected: ExpectedState, invariants: string[]): StepFixture {
  // Echoes deliberately cite the CURRENT message, exactly as an untrusted model
  // can do. Tests must not silently replace that evidence with the old message.
  return { id, message, operation, ai: { facts: facts.map((f) => ({ ...f, evidence: message })), removes }, expected, invariants };
}
const baseMessage = "Ремонтирую бытовую технику. Могу копать. Есть газель. Работаю до 21:00. Доставкой не занимаюсь.";
const baseState = () => state(["appliance_repair", "digging"], ["van"], ["delivery"], [21]);
const base = () => step("base", baseMessage, "add skills/resource/time/work restriction", [skill("appliance_repair"), skill("digging"), resource("van"), time(21), restriction("delivery")], [], baseState(), ["exact_state", "time_matches_order"]);

export const scenarios: Scenario[] = [
  { id: "D4-EMOJI", defect: 4, title: "emoji cannot authorize deletion of any existing category", steps: [base(),
    step("emoji", "🙂", "noop + adversarial removes-all", [], [target("all")], baseState(), ["unrelated_preserves_all", "time_matches_order"])] },
  { id: "D4-NARROW", defect: 4, title: "narrow fridge refusal retains broad appliance repair", steps: [base(),
    step("fridge", "Холодильники больше не ремонтирую", "narrow refusal + wrong broad removal", [revoke("refrigerator_repair")], [target("skill", "appliance_repair")],
      state(["appliance_repair", "digging"], ["van"], ["delivery", "refrigerator_repair"], [21]), ["narrow_not_broad", "exact_state", "time_matches_order"])] },
  { id: "D4-UNRELATED", defect: 4, title: "new independent skill cannot erase the prior profile", steps: [base(),
    step("assembly", "Ещё умею собирать мебель", "add independent skill + adversarial removes-all", [skill("assembly")], [target("all")],
      state(["appliance_repair", "digging", "assembly"], ["van"], ["delivery"], [21]), ["unrelated_preserves_all", "exact_state", "time_matches_order"])] },
  { id: "D5-LIFT-ECHO", defect: 5, title: "explicit time lift wins over the same removed item echoed by AI", steps: [base(),
    step("lift", "Ограничений по времени больше нет", "lift + contradictory echo", [time(21)], [target("time_limit")],
      state(["appliance_repair", "digging"], ["van"], ["delivery"]), ["decision_beats_echo", "no_time_after_lift", "time_matches_order"])] },
  { id: "D5-TIME-ECHO", defect: 5, title: "unrelated echo cannot duplicate or unground an existing time restriction", steps: [base(),
    step("assembly", "Ещё умею собирать мебель", "add skill + stale time echo without time evidence", [skill("assembly"), time(21)], [],
      state(["appliance_repair", "digging", "assembly"], ["van"], ["delivery"], [21]), ["one_global_time", "grounded_time", "time_matches_order"])] },
  { id: "D5-TIME-UPDATE", defect: 5, title: "updated 21:00 window wins over old 22:00 re-emitted as current", steps: [
    step("start", "Могу копать. Работаю до 22:00", "add skill/time", [skill("digging"), time(22)], [], state(["digging"], [], [], [22]), ["time_matches_order"]),
    step("update", "Теперь работаю до 21:00", "update + stale older window", [time(21), time(22)], [target("time_limit")],
      state(["digging"], [], [], [21]), ["one_global_time", "latest_user_decision", "grounded_time", "time_matches_order"])] },
  { id: "D5-REVOKE-ECHO", defect: 5, title: "revoked skill is not restored by an unrelated AI echo", steps: [base(),
    step("revoke", "Больше не копаю", "revoke skill", [revoke("digging")], [target("skill", "digging")], state(["appliance_repair"], ["van"], ["delivery"], [21], ["digging"]), ["exact_state"]),
    step("echo", "Спасибо за помощь", "noop + stale positive echo", [skill("digging")], [], state(["appliance_repair"], ["van"], ["delivery"], [21], ["digging"]), ["no_implicit_restore", "decision_beats_echo"])] },
  { id: "D5-RESOURCE-ECHO", defect: 5, title: "removed resource remains missing until explicit restoration", steps: [base(),
    step("remove", "Газель продал, её больше нет", "remove resource", [resource("van", true)], [target("resource", "van")], state(["appliance_repair", "digging"], [], ["delivery"], [21], [], ["van"]), ["exact_state"]),
    step("echo", "Хорошо, спасибо", "noop + stale resource echo", [resource("van")], [], state(["appliance_repair", "digging"], [], ["delivery"], [21], [], ["van"]), ["no_implicit_restore", "decision_beats_echo"]),
    step("restore", "Снова есть газель", "explicit restore", [resource("van")], [target("no_resource", "van")], baseState(), ["explicit_restore", "exact_state"])] },
  { id: "D45-LONG-18", defect: "4+5", title: "18-message lifecycle with malicious removes and replayed old facts", steps: [
    step("01", "Ремонтирую бытовую технику", "add skill", [skill("appliance_repair")], [], state(["appliance_repair"]), ["exact_state"]),
    step("02", "Могу копать", "add skill", [skill("digging")], [], state(["appliance_repair", "digging"]), ["exact_state"]),
    step("03", "Есть газель", "add resource", [resource("van")], [], state(["appliance_repair", "digging"], ["van"]), ["exact_state"]),
    step("04", "Работаю до 22:00", "set time", [time(22)], [], state(["appliance_repair", "digging"], ["van"], [], [22]), ["one_global_time", "time_matches_order"]),
    step("05", "🙂", "noop + removes-all", [], [target("all")], state(["appliance_repair", "digging"], ["van"], [], [22]), ["unrelated_preserves_all"]),
    step("06", "Холодильники больше не ремонтирую", "narrow restriction + wrong broad removal", [revoke("refrigerator_repair")], [target("skill", "appliance_repair")],
      state(["appliance_repair", "digging"], ["van"], ["refrigerator_repair"], [22]), ["narrow_not_broad"]),
    step("07", "Больше не копаю", "revoke skill", [revoke("digging")], [target("skill", "digging")], state(["appliance_repair"], ["van"], ["refrigerator_repair"], [22], ["digging"]), ["exact_state"]),
    step("08", "Ещё умею собирать мебель", "add skill + echo revoked skill", [skill("assembly"), skill("digging")], [],
      state(["appliance_repair", "assembly"], ["van"], ["refrigerator_repair"], [22], ["digging"]), ["no_implicit_restore"]),
    step("09", "Снова беру заказы на копку", "explicit restore skill", [skill("digging")], [target("removed_skill", "digging")],
      state(["appliance_repair", "assembly", "digging"], ["van"], ["refrigerator_repair"], [22]), ["explicit_restore"]),
    step("10", "Теперь работаю до 21:00", "update time + echo old window", [time(21), time(22)], [target("time_limit")],
      state(["appliance_repair", "assembly", "digging"], ["van"], ["refrigerator_repair"], [21]), ["one_global_time", "time_matches_order"]),
    step("11", "Есть самолёт", "add unknown resource + echo old window", [resource("plane"), time(22)], [],
      state(["appliance_repair", "assembly", "digging"], ["van", "plane"], ["refrigerator_repair"], [21]), ["latest_user_decision", "time_matches_order"]),
    step("12", "Газель продал, её больше нет", "remove resource", [resource("van", true)], [target("resource", "van")],
      state(["appliance_repair", "assembly", "digging"], ["plane"], ["refrigerator_repair"], [21], [], ["van"]), ["exact_state"]),
    step("13", "🙂 Спасибо", "noop + removed resource echo", [resource("van")], [],
      state(["appliance_repair", "assembly", "digging"], ["plane"], ["refrigerator_repair"], [21], [], ["van"]), ["no_implicit_restore", "time_matches_order"]),
    step("14", "Снова есть газель", "explicit restore resource", [resource("van")], [target("no_resource", "van")],
      state(["appliance_repair", "assembly", "digging"], ["van", "plane"], ["refrigerator_repair"], [21]), ["explicit_restore"]),
    step("15", "Ограничений по времени больше нет", "lift + echo removed time", [time(21)], [target("time_limit")],
      state(["appliance_repair", "assembly", "digging"], ["van", "plane"], ["refrigerator_repair"]), ["no_time_after_lift", "time_matches_order"]),
    step("16", "Хорошо, спасибо", "noop + lifted time echo", [time(21)], [],
      state(["appliance_repair", "assembly", "digging"], ["van", "plane"], ["refrigerator_repair"]), ["no_implicit_restore", "no_time_after_lift", "time_matches_order"]),
    step("17", "Доставкой не занимаюсь", "add independent work restriction", [restriction("delivery")], [],
      state(["appliance_repair", "assembly", "digging"], ["van", "plane"], ["refrigerator_repair", "delivery"]), ["exact_state"]),
    step("18", "Теперь работаю до 20:00", "new time restriction after lift", [time(20)], [],
      state(["appliance_repair", "assembly", "digging"], ["van", "plane"], ["refrigerator_repair", "delivery"], [20]), ["one_global_time", "time_matches_order"]),
  ] },
];
