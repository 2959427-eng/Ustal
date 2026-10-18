import fs from 'node:fs';
process.env.NODE_ENV='test';
const {assertLocalTestDatabase,getDb,getSql}=await import('@ustal/database');assertLocalTestDatabase();
if(new URL(process.env.DATABASE_URL).pathname!=='/ustal_readiness_test')throw Error('Readiness DB required');
const {sql}=await import('drizzle-orm');const db=getDb();
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const run=JSON.parse(fs.readFileSync(arg('--baseline','docs/evaluations/semantic-readiness-paced-run.json'),'utf8'));
const dataset=JSON.parse(fs.readFileSync('docs/evaluations/semantic-readiness-dataset.json','utf8'));
const file=arg('--output','docs/evaluations/semantic-readiness-extra.json'),out=JSON.parse(fs.readFileSync(file,'utf8'));
try{
 out.liveFailedCaseIntegrity=[];
 for(const c of run.cases.filter(c=>c.decision==='error')){
  const[state]=await db.execute(sql`select (select count(*)::int from capability_profiles where user_id=${c.userId}) profiles,(select count(*)::int from profile_source_inputs where user_id=${c.userId} and status='confirmed' and raw_text=${dataset.cases.find(d=>d.id===c.id).profile_text}) intact_source`);
  let orderState;
  if(c.error.stage==='order') [orderState]=await db.execute(sql`select status,source_text,(select count(*)::int from matching_documents where order_id=o.id) docs,(select count(*)::int from order_requirements where order_id=o.id) requirements from orders o where id=${c.orderId}`);
  const passed=state.intact_source===1&&(c.error.stage==='profile'?state.profiles===0:c.error.stage==='order'&&orderState?.status==='processing_failed'&&orderState.source_text===dataset.cases.find(d=>d.id===c.id).order_text&&orderState.docs===0&&orderState.requirements===0);
  out.liveFailedCaseIntegrity.push({id:c.id,stage:c.error.stage,state,orderState,passed});
 }
 const[dupes]=await db.execute(sql`select count(*)::int n from (select matching_run_id,user_id from matching_candidates group by matching_run_id,user_id having count(*)>1) d`);
 out.globalDuplicateCandidatePairs=dupes.n;
 out.passed=out.checks.every(c=>c.passed)&&out.liveFailedCaseIntegrity.every(c=>c.passed)&&dupes.n===0;
 fs.writeFileSync(file,JSON.stringify(out,null,2));console.log(JSON.stringify({liveErrors:out.liveFailedCaseIntegrity,duplicatePairs:dupes.n,passed:out.passed}));
}finally{await getSql().end();}
