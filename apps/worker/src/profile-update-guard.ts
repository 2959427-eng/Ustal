import type { SemanticFact } from "@ustal/validation";
import { isRevokedCapability, REVOKED_CAPABILITY } from "./profile-negatives.js";
import { areaOf, SUPERSEDED_KIND, toSupersededMarker } from "./profile-restrictions.js";
import { attributesChange, mergeAttributes, type ResourceAttribute } from "./profile-item-attributes.js";

/**
 * Серверная проверка операций AI при обновлении профиля по одному сообщению (QA 2026-10-14, дефекты №4/№5).
 *
 * AI видит только новое сообщение и текущее состояние (CURRENT_PROFILE) и предлагает новые факты и removes.
 * Сервер не доверяет этому ответу произвольное изменение профиля:
 *  - сообщение без содержания (эмодзи, «спасибо», «хорошо») — no-op: ни фактов, ни удалений;
 *  - время — только с основанием в новом сообщении (часы названы в нём); окно без основания не создаётся,
 *    а не превращается в «окно» без часов, которое показывается, но не исполняется;
 *  - повтор пункта, который уже в профиле в том же состоянии, — no-op;
 *  - изменение состояния существующего пункта (восстановление снятого навыка или проданного ресурса,
 *    повторный отказ, снятие ограничения) — только если новое сообщение называет именно этот пункт;
 *  - remove применяется только к пункту, к которому сообщение явно относится: либо его подтверждает
 *    новый факт о том же пункте (тогда решают прежние детерминированные правила по порядку сообщений),
 *    либо сообщение называет пункт вместе с признаком отмены. Узкий отказ («холодильники») не удаляет
 *    более широкий навык («ремонт бытовой техники»). Все прочие пункты профиля неизменяемы.
 * Пункты из составных сообщений (2026-10-15): у пункта есть подпись (label) и у ресурса — характеристики.
 *  - ссылка модели на пункт (itemRef) — предложение: она связывает факт с пунктом, только если сообщение
 *    упоминает этот пункт (все слова его фразы/подписи, или хотя бы одно, если других таких пунктов нет);
 *  - новые характеристики/уточнение подписи имеющегося ресурса — только при явной отсылке к этому объекту
 *    («этот автобус», «эта машина», «у него»); без неё это, возможно, другой объект — новый пункт;
 *    если упомянутых подходящих ресурсов несколько — изменение не применяется (неоднозначно).
 * Отклонённые операции возвращаются в rejected для диагностики.
 */
export type Fact = SemanticFact & { nodeIds: string[]; embedding: number[] };
export type ItemType = "skill" | "resource" | "no_resource" | "refusal" | "removed_skill" | "time_limit" | "only_scope";
export interface GuardInput<T extends Fact> {
  message: string;
  /** Действующие (не superseded) факты прежнего состояния. */
  prior: T[];
  /** Пункты CURRENT_PROFILE, которые видела модель: id → факт прежнего состояния. */
  items: { id: string; type: ItemType }[];
  byId: Map<string, T>;
  added: T[];
  removes: string[];
  /** Названия и синонимы узлов онтологии (для проверки, что сообщение называет пункт). */
  nodeNames: (nodeId: string) => string[];
}
export interface GuardResult<T extends Fact> {
  added: T[];
  /** Прежние факты, которые заменены (удалены из действующего состояния). */
  dropped: Set<T>;
  /** История: снятые ограничения (kind=superseded). */
  history: T[];
  rejected: { op: string; reason: string }[];
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
const words = (s: string) => norm(s).split(/[^a-zа-я0-9]+/).filter(Boolean);
const STOP = new Set(["и", "в", "во", "на", "с", "со", "по", "для", "до", "от", "из", "к", "ко", "у", "о", "об", "за", "не", "ни", "нет",
  "это", "я", "мы", "вы", "есть", "был", "была", "было", "могу", "умею", "работаю", "работы", "работа", "заказы", "заказ", "заказов",
  "беру", "брать", "больше", "уже", "еще", "снова", "опять", "теперь", "тоже", "также", "все", "всё", "свой", "своя", "свои", "мой", "моя",
  "мои", "очень", "или", "а", "но", "да", "же", "ли", "бы", "услуги", "услуга"]);
/** Сообщение без содержания: эмодзи, благодарность, согласие. */
const NOISE = new Set(["спасибо", "благодарю", "спс", "хорошо", "ок", "окей", "ok", "ладно", "понятно", "привет", "здравствуйте", "супер",
  "отлично", "круто", "класс", "пожалуйста", "ага", "угу", "да", "понял", "поняла", "ясно", "добрый", "день", "вечер", "утро", "за", "помощь"]);
export const isNoiseMessage = (message: string) => words(message).every((w) => NOISE.has(w));

/** Слова совпадают, если общая начальная часть ≥ 3 букв и ≥ 60% более короткого слова («копать»/«копку»). */
function sameStem(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 3 && i >= Math.ceil(0.6 * Math.min(a.length, b.length));
}
const content = (s: string) => words(s).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
/** Сообщение называет текст: каждое содержательное слово текста есть в сообщении (с точностью до формы). */
export function namedIn(message: string, text: string) {
  const need = content(text);
  if (!need.length) return false;
  const have = words(message);
  return need.every((w) => have.some((m) => sameStem(w, m)));
}

// Время в тексте: «21:00», «с 9 до 18», «до 18ч», «днём», «по вечерам», «в выходные», дни недели.
const TIME_IN_TEXT = /\d{1,2}[:.]\d{2}|(?:^|[^а-яёa-z0-9])(?:с|до|после|от|в|к|со)\s+\d{1,2}(?!\d)|\d{1,2}\s*(?:ч(?![а-яё])|час)|утр|вечер|ноч|дн[её]м|днями|обед|полдн|сутк|круглосуточ|выходн|будн|понедельн|вторник|сред[аыуо]|средам|четверг|пятниц|суббот|воскрес/i;
export const mentionsTime = (text: string) => TIME_IN_TEXT.test(text);
const TIME_AREA = /врем|час|график|расписан/i;
const LIFT_CUE = /(^|[^а-яё])(нет|больше не|без|снял|сняла|сними|отмен|убер|убра|любое|круглосуточ|не огранич)/i;
const NEGATION = /(^|[^а-яё])(не|нет|без|больше не|уже не|продал|продала|отдал|отдала|сломал|сломался|сломалась|потерял|потеряла|украли|поменял|поменяла|заменил|заменила|сменил|сменила|убери|удали)([^а-яё]|$)/i;
/** Явная отсылка к уже названному объекту: «этот автобус», «эта машина», «у него», «тот же». */
const REFERENCE = /(^|[^а-яё])(этот|эта|это|этого|этой|этому|этим|эту|тот же|та же|того же|той же|него|неё|нее|он|она|оно)([^а-яё]|$)/i;
/** Явно другой объект того же вида: «ещё одна машина», «второй автобус», «другая лестница». */
const ANOTHER = /(^|[^а-яё])(ещ[её] (одн[аоуи]|один|одного|одной)|втор(ой|ая|ое|ую|ого|ую)|друг(ой|ая|ое|ую|ого)|треть(я|е|ю)|трет(ий|ьего))([^а-яё]|$)/i;
const hasHours = (f: Pick<Fact, "startHour" | "endHour" | "daysOfWeek">) => f.startHour != null || f.endHour != null || !!f.daysOfWeek?.length;

/**
 * Часы факта основаны на тексте: время названо, и если в тексте есть числа часов — часы факта среди них
 * (с учётом «9 вечера» = 21). «Теперь работаю до 21:00» не может дать окно до 22:00.
 */
export function hoursGrounded(f: Pick<Fact, "startHour" | "endHour" | "daysOfWeek">, text: string) {
  if (!mentionsTime(text)) return false;
  const nums = new Set([...norm(text).matchAll(/(?<![\d])(\d{1,2})(?![\d])/g)].map((m) => Number(m[1])).filter((n) => n <= 24));
  if (!nums.size) return true;
  const ok = (h: number | null | undefined) => h == null || nums.has(h) || nums.has(h - 12) || (h === 0 && nums.has(24)) || (h === 24 && nums.has(0));
  return ok(f.startHour) && ok(f.endHour);
}

const isRefusal = (f: Fact) => f.kind === "exclude" || f.constraintType === "exclusion";
const isTime = (f: Fact) => f.kind === "availability" || f.constraintType === "availability";
/** Положение пункта в профиле: навык, снятый навык, отказ, ресурс, отсутствующий ресурс, время, «только». */
function stateOf(f: Fact): ItemType | null {
  if ((f.kind as string) === SUPERSEDED_KIND) return null;
  if (isRefusal(f)) return isRevokedCapability(f) ? "removed_skill" : "refusal";
  if (isTime(f)) return "time_limit";
  if (f.constraintType === "scope") return "only_scope";
  if (f.kind === "capability") return "skill";
  if (f.kind === "resource") return f.resourceRole === "missing" ? "no_resource" : "resource";
  return null;
}
const family = (t: ItemType | null) => (t === "resource" || t === "no_resource" ? "resource" : t === "time_limit" ? "time" : t ? "activity" : null);
/** Тот же пункт: общий узел онтологии, а без узла (неизвестный пункт) — та же фраза или та же подпись. */
const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && content(a).length > 0 && content(a).join(" ") === content(b).join(" ");
function samePoint(a: Fact, b: Fact) {
  if (family(stateOf(a)) !== family(stateOf(b))) return false;
  if (a.nodeIds.length && b.nodeIds.length) return a.nodeIds.some((id) => b.nodeIds.includes(id));
  if (!a.nodeIds.length && !b.nodeIds.length) return sameText(a.phrase, b.phrase) || sameText(a.label, b.label);
  return false;
}
const attrsOf = (f: Fact) => (f.attributes ?? []) as ResourceAttribute[];

export function guardProfileUpdate<T extends Fact>(input: GuardInput<T>): GuardResult<T> {
  const { message, prior } = input;
  const rejected: GuardResult<T>["rejected"] = [];
  const dropped = new Set<T>();
  const history: T[] = [];
  const label = (f: Fact) => `${f.kind}:${f.phrase}${f.endHour != null ? `@${f.endHour}` : ""}`;
  const names = (f: Fact) => [f.phrase, ...(f.label ? [f.label] : []), ...f.nodeIds.flatMap(input.nodeNames)];
  const named = (...facts: Fact[]) => facts.some((f) => names(f).some((t) => namedIn(message, t)));
  // Сообщение затрагивает пункт: хотя бы одно содержательное слово его фразы или подписи (не названия узла).
  const have = words(message);
  const touched = (p: Fact) => [p.phrase, p.label ?? ""].flatMap(content).some((w) => w.length >= 4 && have.some((m) => sameStem(w, m)));
  // Упоминание пункта: названы все его слова, или затронут он один среди пунктов того же рода.
  const mentions = (p: T) => named(p) || (touched(p) && prior.filter((q) => family(stateOf(q)) === family(stateOf(p)) && touched(q)).length === 1);
  // Ссылка модели на пункт (itemRef) связывает факт с ним только при упоминании пункта в сообщении.
  const linked = (f: Fact, p: T) => samePoint(f, p) || (!!f.itemRef && input.byId.get(f.itemRef) === p &&
    family(stateOf(f)) === family(stateOf(p)) && mentions(p));

  if (isNoiseMessage(message)) {
    for (const f of input.added) rejected.push({ op: `add ${label(f)}`, reason: "message has no content" });
    for (const id of input.removes) rejected.push({ op: `remove ${id}`, reason: "message has no content" });
    return { added: [], dropped, history, rejected };
  }

  // Пункты, на которые модель явно указала операцией (removes). По контракту (PROFILE_UPDATE_RULE) изменение
  // существующего пункта приходит парой «новый факт + remove этого пункта»; факт о существующем пункте без
  // такой операции — повтор (echo) старого состояния, а не решение пользователя.
  // Указанию модели верим, только если её removes избирательны: каждый подкреплён новым фактом о том же пункте
  // или пункт назван в сообщении. «Удалить всё» или удаления, ничем в сообщении не обоснованные, означают, что
  // ответ ненадёжен, — тогда изменение существующего пункта принимается только по его упоминанию в сообщении.
  const removedPoints = input.removes.map((id) => input.byId.get(id)).filter((p): p is T => !!p);
  const backedByFact = (p: T) => input.added.some((f) => linked(f, p) && stateOf(f) !== stateOf(p));
  const indiscriminate = (input.items.length >= 2 && new Set(input.removes).size >= input.items.length) ||
    removedPoints.some((p) => stateOf(p) !== "time_limit" && !backedByFact(p) && !mentions(p));
  const targeted = new Set(indiscriminate ? [] : removedPoints);

  // 1. Новые факты.
  const added: T[] = [];
  for (const f of input.added) {
    if (hasHours(f) && !hoursGrounded(f, message)) {
      if (isTime(f)) { rejected.push({ op: `add ${label(f)}`, reason: "time not stated in this message" }); continue; }
      f.startHour = null; f.endHour = null; f.daysOfWeek = null;
    }
    const state = stateOf(f);
    const same = prior.filter((p) => linked(f, p));
    const sameState = same.filter((p) => stateOf(p) === state);
    if (state === "resource" && sameState.length && !f.itemRef && ANOTHER.test(message) && (named(f) || touched(f as T))) {
      // Ещё один объект того же вида: отдельный пункт; одинаковая подпись получает номер («Машина 2»),
      // иначе два объекта не различить ни в профиле, ни при последующих изменениях.
      const base = f.label ?? f.phrase;
      const taken = [...prior, ...added].filter((p) => stateOf(p) === "resource" && sameText(p.label ?? p.phrase, base)).length;
      const n = taken + 1;
      added.push({ ...f, itemRef: null, label: `${base} ${n}`, phrase: `${f.phrase} ${n}` }); continue;
    }
    if (state === "resource" && sameState.length) {
      // Тот же ресурс с новыми характеристиками или уточнённой подписью («эта машина грузовая, 5 тонн»).
      const refines = (p: T) => !!f.label && !sameText(f.label, p.label ?? p.phrase) && namedIn(f.label, p.label ?? p.phrase);
      const changed = sameState.filter((p) => attributesChange(attrsOf(p), attrsOf(f)) || refines(p));
      if (!changed.length) { rejected.push({ op: `add ${label(f)}`, reason: "already in profile in the same state" }); continue; }
      if (REFERENCE.test(message)) {
        const candidates = prior.filter((q) => stateOf(q) === "resource" && (named(q) || touched(q)));
        const target = changed.length === 1 && candidates.length <= 1 ? changed[0]! : null;
        if (!target || !mentions(target)) {
          rejected.push({ op: `update ${label(f)}`, reason: target ? "update of an item the message does not mention" : "ambiguous: several existing items match" }); continue;
        }
        dropped.add(target);
        added.push({ ...target, label: refines(target) ? f.label : target.label,
          nodeIds: refines(target) && f.nodeIds.length ? f.nodeIds : target.nodeIds,
          attributes: mergeAttributes(attrsOf(target), attrsOf(f)) });
        continue;
      }
      // Без явной отсылки это, возможно, другой объект того же вида («есть грузовая машина 5 тонн»): новый пункт —
      // но только если сообщение о нём говорит (иначе это повтор старого пункта моделью).
      if (!named(f) && !touched(f as T)) { rejected.push({ op: `add ${label(f)}`, reason: "echo of an existing item" }); continue; }
      added.push({ ...f, itemRef: null }); continue;
    }
    if (state !== "time_limit" && sameState.length) {
      rejected.push({ op: `add ${label(f)}`, reason: "already in profile in the same state" }); continue;
    }
    // Состояние существующего пункта меняется (отзыв, восстановление): тот же пункт — та же подпись и фраза,
    // чтобы небольшое расхождение формулировки не создало дубль.
    const ref = same.find((p) => stateOf(p) !== state);
    if (ref && !samePoint(f, ref))
      Object.assign(f, { phrase: ref.phrase, label: ref.label ?? f.label, nodeIds: f.nodeIds.length ? f.nodeIds : ref.nodeIds, embedding: ref.embedding });
    const changes = same.filter((p) => stateOf(p) !== state);
    if (changes.length && state !== "time_limit") {
      // Изменение состояния существующего пункта — только если модель явно указала этот пункт (remove) или
      // новое сообщение называет именно его. Отказ — только из сообщения с отрицанием.
      // Восстановление снятого навыка / вернувшийся ресурс — только если сообщение называет пункт: указание
      // модели (remove) вместе с повтором (echo) не может вернуть снятое (реальный случай 2026-10-14).
      const restoring = changes.some((p) => ["removed_skill", "refusal", "no_resource"].includes(stateOf(p)!)) && (state === "skill" || state === "resource");
      if (restoring && !named(f, ...changes) && !changes.some(mentions)) {
        rejected.push({ op: `add ${label(f)}`, reason: "restore of an item the message does not mention" }); continue;
      }
      if (!changes.some((p) => targeted.has(p)) && !named(f, ...changes) && !changes.some(mentions)) {
        rejected.push({ op: `add ${label(f)}`, reason: "changes an existing item without an operation on it or a mention of it" }); continue;
      }
      if ((state === "refusal" || state === "no_resource") && !NEGATION.test(message)) {
        rejected.push({ op: `add ${label(f)}`, reason: "cancellation without a negation in the message" }); continue;
      }
      // Восстановление (снова навык / снова есть ресурс) не может прийти из отрицания.
      const restores = (state === "skill" || state === "resource") && changes.some((p) => ["removed_skill", "refusal", "no_resource"].includes(stateOf(p)!));
      if (restores && NEGATION.test(message) && input.added.some((g) => g !== f && samePoint(g, f) && stateOf(g) !== state)) {
        rejected.push({ op: `add ${label(f)}`, reason: "restore contradicted by a negation in the same message" }); continue;
      }
    }
    added.push(f);
  }

  // 2. Удаления: только пункта, к которому сообщение явно относится.
  const addedRefusals = added.filter(isRefusal);
  for (const id of input.removes) {
    const p = input.byId.get(id);
    const item = input.items.find((i) => i.id === id);
    if (!p || !item) { rejected.push({ op: `remove ${id}`, reason: "unknown item" }); continue; }
    const op = `remove ${id} ${item.type} ${label(p)}`;
    // Новый факт о том же пункте подтверждает изменение — его применят детерминированные правила порядка.
    // Для окна времени подтверждение — новое окно той же области (замена), для пункта — его новое состояние.
    const backed = added.some((f) => item.type === "time_limit" ? isTime(f) && areaOf(f) === areaOf(p) : (samePoint(f, p) || f.phrase === p.phrase) && stateOf(f) !== item.type);
    if (backed) continue;
    if (item.type === "time_limit") {
      if (TIME_AREA.test(message) || mentionsTime(message) ? LIFT_CUE.test(message) : false) { dropped.add(p); history.push(toSupersededMarker(p)); }
      else rejected.push({ op, reason: "message does not lift a time restriction" });
      continue;
    }
    if (!mentions(p)) { rejected.push({ op, reason: "message does not mention this item" }); continue; }
    // Отказ от другого (более узкого) пункта не удаляет этот: «холодильники» ≠ «ремонт бытовой техники».
    if ((item.type === "skill") && addedRefusals.some((r) => !samePoint(r, p))) { rejected.push({ op, reason: "refusal in this message is about another item" }); continue; }
    const negated = NEGATION.test(message);
    const evidence = message;
    switch (item.type) {
      case "skill":
        if (!negated) { rejected.push({ op, reason: "no cancellation in the message" }); break; }
        dropped.add(p);
        added.push({ ...p, kind: "exclude", constraintType: "exclusion", constraintScope: "whole_task", refusalIntent: "revoke", evidence,
          resourceCapacity: { value: null, unit: null, kind: REVOKED_CAPABILITY } });
        break;
      case "resource":
        if (!negated) { rejected.push({ op, reason: "no cancellation in the message" }); break; }
        dropped.add(p);
        added.push({ ...p, resourceRole: "missing", evidence });
        break;
      case "removed_skill":
        if (negated) { rejected.push({ op, reason: "restore contradicted by a negation" }); break; }
        dropped.add(p);
        added.push({ ...p, kind: "capability", constraintType: "none", refusalIntent: null, evidence, resourceCapacity: { value: null, unit: null, kind: null } });
        break;
      case "no_resource":
        if (negated) { rejected.push({ op, reason: "restore contradicted by a negation" }); break; }
        dropped.add(p);
        added.push({ ...p, resourceRole: "available", evidence });
        break;
      default: // refusal / only_scope: снятие ограничения — в историю
        dropped.add(p);
        history.push(toSupersededMarker(p));
    }
  }
  return { added, dropped, history, rejected };
}
