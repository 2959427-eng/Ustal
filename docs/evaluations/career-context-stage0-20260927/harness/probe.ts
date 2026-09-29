import { readFileSync, writeFileSync } from "node:fs";
import { buildProfile, buildOrder, match, factView, pool, type ProfileDoc, type OrderDoc } from "./lib.js";
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const only = process.argv[2];
const orderIds = new Set<string>();
const jobs: { key: string; profileText: string; cumulativeFrom?: string; orders: Record<string, string>; group: string; variant: string }[] = [];
for (const p of cases.profiles) {
  if (only && !p.id.startsWith(only)) continue;
  jobs.push({ key: `${p.id}:base`, profileText: p.base, orders: p.orders, group: p.id, variant: "base" });
  jobs.push({ key: `${p.id}:career`, profileText: p.career, orders: p.orders, group: p.id, variant: "career" });
  if (p.cumulative) jobs.push({ key: `${p.id}:cumulative`, profileText: p.career.replace(p.base, "").replace(/\s+/g, " ").trim(), cumulativeFrom: p.base, orders: p.orders, group: p.id, variant: "cumulative" });
  Object.keys(p.orders).forEach((o) => orderIds.add(o));
}
if (!only || only === "V") {
  const d = cases.distinction;
  jobs.push({ key: "V0:base", profileText: d.base, orders: d.variants[0].orders, group: "V", variant: "base" });
  for (const v of d.variants) { jobs.push({ key: `${v.id}`, profileText: `${d.base} ${v.add}`, orders: v.orders, group: "V", variant: v.id });
    Object.keys(v.orders).forEach((o) => orderIds.add(o)); }
}
const orders = new Map<string, OrderDoc>();
await pool([...orderIds].map((id) => async () => { orders.set(id, await buildOrder(id, cases.orders[id])); }));
const baseCache = new Map<string, ProfileDoc>();
const profiles = await pool(jobs.map((j) => async () => {
  let prior: ProfileDoc | undefined;
  if (j.cumulativeFrom) { prior = baseCache.get(j.cumulativeFrom) ?? await buildProfile("prior", j.cumulativeFrom); baseCache.set(j.cumulativeFrom, prior); }
  return { job: j, profile: await buildProfile(j.key, j.profileText, prior) };
}));
const pairs = profiles.flatMap(({ job, profile }) => Object.entries(job.orders).map(([oid, expected]) => ({ job, profile, oid, expected })));
const results = await pool(pairs.map((x) => async () => ({ key: x.job.key, group: x.job.group, variant: x.job.variant, order: x.oid, expected: x.expected, ...(await match(x.profile, orders.get(x.oid)!)) })));
const out = { runAt: new Date().toISOString(), orders: Object.fromEntries([...orders].map(([k, v]) => [k, { risk: v.riskLevel, regulated: v.regulated, facts: factView(v.doc) }])),
  profiles: Object.fromEntries(profiles.map(({ job, profile }) => [job.key, { source: profile.doc.sourceText, facts: factView(profile.doc) }])), results };
const file = process.argv[3] ?? new URL(`./results-${Date.now()}.json`, import.meta.url).pathname;
writeFileSync(file, JSON.stringify(out, null, 2));
for (const r of results) console.log([r.key.padEnd(24), r.order.padEnd(14), r.expected.padEnd(15), r.decision.padEnd(7), (r.classification + "/" + r.reason).padEnd(45),
  "pre=" + r.preReview, "sim=" + r.docSim, "canon=" + r.canonicalHit, r.review?.hardConflict ? "HC=" + JSON.stringify(r.review.hardConflict) : "", r.review ? `rev=${r.review.compatible}/${r.review.confidence}` : (r.reviewFailed ? "REVIEW_FAILED:" + r.reviewFailed.name : "norev")].join(" | "));
console.log("written", file);
