// Diagnostic only: label-blind selection by pipeline gate, no DB writes or production requests.
import fs from 'node:fs';
import {parse} from 'dotenv';
import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2);if(!args.includes('--live')||!args.includes('--ai-env'))throw Error('Explicit live opt-in required');
process.env.NODE_ENV='test';
const {assertLocalTestDatabase}=await import('@ustal/database');assertLocalTestDatabase();
if(new URL(process.env.DATABASE_URL).pathname!=='/ustal_readiness_test')throw Error('Readiness DB required');
const env=parse(fs.readFileSync(args[args.indexOf('--ai-env')+1]));for(const k of ['OPENAI_API_KEY','OPENAI_BASE_URL','AI_MODEL_SEMANTIC_REVIEW'])if(env[k])process.env[k]=env[k];
Object.assign(process.env,{AI_PROVIDER:'openai',JWT_ACCESS_SECRET:'local-probe-access-only',JWT_REFRESH_SECRET:'local-probe-refresh-only'});
const {getAiProviders}=await import('@ustal/ai');const ai=getAiProviders();
const base=JSON.parse(fs.readFileSync('docs/evaluations/semantic-matching-production-readiness.json','utf8'));
const selected=base.cases.filter(c=>c.completed&&c.riskLevel===0&&c.trace?.reason==='insufficient_capability_evidence'&&c.profile?.facts.some(f=>f.kind==='capability'&&Number(f.confidence)>=.5)&&c.order?.facts.some(f=>f.kind==='capability'));
const out={startedAt:new Date().toISOString(),selection:'ALL baseline risk0 unresolved-capability cases with positive capabilities and requested actions; labels not used to select',selected:selected.map(c=>c.id),cases:[]};
for(const c of selected){
 const entry={id:c.id,expected:c.expected_label,cosine:c.trace.semantic_similarity,results:{}};out.cases.push(entry);
 for(const variant of ['normalized','source']){
  const input=variant==='normalized'?{profile:c.profile.facts.filter(f=>f.kind==='capability'&&Number(f.confidence)>=.5).map(f=>f.phrase),order:c.order.facts.filter(f=>f.kind==='capability').map(f=>f.phrase)}:{profile:[c.profile_text],order:[c.order_text]};
  const start=performance.now();try{const r=await ai.extraction.reviewSemantic(input,{operationType:'diagnostic_review_probe',traceId:randomUUID(),promptVersion:'existing-reviewer',schemaVersion:'v1'});entry.results[variant]={input,raw:r.data,accepted:r.data.compatible&&r.data.confidence>=.9,model:r.model,tokensInput:r.tokensInput,tokensOutput:r.tokensOutput,ms:performance.now()-start};}catch(e){entry.results[variant]={error:{name:e.name,status:e.status??null}};}
  fs.writeFileSync('docs/evaluations/semantic-fn-review-probe.json',JSON.stringify(out,null,2));await new Promise(r=>setTimeout(r,2500));
 }
 console.log(JSON.stringify({id:c.id,normalized:entry.results.normalized.accepted,source:entry.results.source.accepted}));
}
out.finishedAt=new Date().toISOString();fs.writeFileSync('docs/evaluations/semantic-fn-review-probe.json',JSON.stringify(out,null,2));
