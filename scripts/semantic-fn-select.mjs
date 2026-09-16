// Final selection gate: retain the tested implementation, never hide the rejected experiment.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const dir='docs/evaluations/',read=p=>JSON.parse(fs.readFileSync(dir+p,'utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const dataset=read('semantic-readiness-dataset.json');
if(hash(JSON.stringify(dataset.cases))!==dataset.sha256)throw Error('Frozen dataset changed');
const selected=read('semantic-fn-r4-run.json');
const checks=Object.entries(selected.codeHashes).map(([path,expected])=>({path,expected,actual:hash(fs.readFileSync(path,'utf8'))}));
if(checks.some(c=>c.expected!==c.actual))throw Error('Current pipeline differs from selected round4');
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(head!==selected.head)throw Error('HEAD changed');
const rounds=[];
for(let i=1;i<=5;i++){
 const run=read(`semantic-fn-r${i}-run.json`),repeat=read(`semantic-fn-r${i}-repeat.json`);
 if(run.cases.filter(c=>c.finishedAt).length!==200||new Set(run.cases.map(c=>c.id)).size!==200||repeat.repeats.filter(c=>c.finishedAt).length!==40)throw Error(`Incomplete round${i}`);
 if(run.datasetSha!==dataset.sha256||repeat.datasetSha!==dataset.sha256||JSON.stringify(run.codeHashes)!==JSON.stringify(repeat.codeHashes))throw Error(`Inconsistent round${i}`);
 const ids=dataset.cases.filter(c=>c.repeat_selected).map(c=>c.id);
 if(ids.length!==20||ids.some(id=>repeat.repeats.filter(c=>c.id===id).length!==2))throw Error('Repeat set changed');
 rounds.push({round:i,attempted:200,uniquePairs:200,repeatTrials:40,datasetAndCodeConsistent:true});
}
const out={selectedRound:4,rejectedRound:5,verifiedAt:new Date().toISOString(),head,datasetSha:dataset.sha256,checks,rounds,
 reason:'Retained round4: all numerical targets met (precision97.67%, recall96.18%,200/200 processed,20/20 stable). Rejected round5 resource-allocation contract: recall89.31%,196/200 processed,16/20 stable,FP4/FN14; ordinary capabilities became mandatory more often. Four connection failures are separate infrastructure observations and do not explain the semantic regression. Restored the exact round4 pipeline files; no new cold-run metrics are claimed after restoration.',
 retainedChanges:['Dedicated normalization model','Bounded validation repair','Server-owned exact evidence spans','Source-aware semantic review without a cosine admission veto'],
 rejectedChanges:['Extended orderResourceSupply normalizer wire contract; helper and unit tests retained as an inactive experiment, not imported by runtime'],
 remainingFalseNegatives:[
  {id:'B05',stage:'risk extraction / qualification gate',cause:'Legacy extraction requires qualification for appliance connection; verification is absent.',fix:'Separate ordinary task competence from formal qualification requirements; do not waive verification.'},
  {id:'B30',stage:'risk extraction / qualification gate',cause:'Legacy extraction requires qualification for replacing a flexible plumbing connector.',fix:'Review risk semantics with independent labels.'},
  {id:'C03',stage:'normalization / mandatory resource gate',cause:'Onsite plan and tools are required from the executor despite being supplied.',fix:'Separate resource allocation without perturbing capability necessity; round5 approach rejected.'},
  {id:'G07',stage:'normalization / mandatory resource gate',cause:'Customer-provided mower becomes executor ownership requirement.',fix:'Separate resource allocation without perturbing capability necessity; round5 approach rejected.'},
  {id:'G02',stage:'normalization completeness / review admission',cause:'Only van resource retained; implicit transport action absent from normalized order facts, so review not invoked.',fix:'Validate action completeness and task intent; do not confuse owning a resource with a skill.'},
 ],
 remainingFalsePositives:[{id:'C37',cause:'Broad assembly canonical node hides task scope.'},{id:'E12',cause:'Reviewer treats absence of refusal as positive ability evidence.'},{id:'F12',cause:'Time constraint is represented in the wrong fact kind and missed by the availability gate.'}],
 readyForProduction:false};
fs.writeFileSync(dir+'semantic-fn-selection.json',JSON.stringify(out,null,2));
console.log(JSON.stringify({selectedRound:4,pipelineHashesVerified:checks.length,roundsVerified:rounds.length,head,datasetSha:dataset.sha256}));
