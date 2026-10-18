import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Writes two real QA accounts and one order; credentials come from process env only.
const required = ['SMOKE_BASE_URL', 'SMOKE_CUSTOMER_PHONE', 'SMOKE_EXECUTOR_PHONE', 'SMOKE_PASSWORD'];
for (const key of required) assert(process.env[key], `Missing ${key}`);
assert.equal(process.env.SMOKE_ALLOW_WRITES, 'yes', 'Set SMOKE_ALLOW_WRITES=yes for the intended target');
const base = new URL(process.env.SMOKE_BASE_URL);
assert(base.protocol === 'https:' || ['localhost','127.0.0.1'].includes(base.hostname), 'Use HTTPS');
const run = randomUUID();
const timeout = Number(process.env.SMOKE_TIMEOUT_MS || 240000);
async function request(method, path, token, body, expected = [200,201,202,204]) {
  const response = await fetch(new URL(path, base), {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  // Never dump responses containing tokens or personal data.
  assert(expected.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function poll(label, read, done) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    if (['processing_failed','moderation_hold','rejected'].includes(value?.status)) throw new Error(`${label}: ${value.status}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`${label}: timed out; inspect worker and AI configuration`);
}
async function main() {
  assert.equal((await request('GET','/health')).status, 'ok');
  const cities = await request('GET','/cities');
  const cityId = process.env.SMOKE_CITY_ID || cities[0]?.id;
  assert(cityId, 'Seed cities first');
  const tokens = [];
  for (const [role, phone] of [['customer',process.env.SMOKE_CUSTOMER_PHONE],['executor',process.env.SMOKE_EXECUTOR_PHONE]]) {
    await request('POST','/auth/register',null,{name:`QA ${role} ${run.slice(0,8)}`,phone,password:process.env.SMOKE_PASSWORD,cityId,acceptedRules:true,acceptedPdn:true});
    const login = await request('POST','/auth/login',null,{phone,password:process.env.SMOKE_PASSWORD});
    assert(login.accessToken, 'Missing access token'); tokens.push(login.accessToken);
    await request('GET','/profile',login.accessToken);
  }
  const [customer, executor] = tokens;
  console.log('PASS health/register/login/profile');
  await request('POST','/profile/inputs',executor,{inputType:'text',text:'Собираю мебель: столы и шкафы. Есть шуруповёрт и полный набор инструментов для сборки мебели.'});
  const draft = await poll('profile extraction',()=>request('GET','/profile/draft',executor),v=>v.draft?.id);
  await request('POST',`/profile/draft/${draft.draft.id}/apply`,executor,{});
  const profile = await request('GET','/profile',executor);
  assert(profile.capabilities?.length, 'Profile has no extracted capabilities');
  const order = await request('POST','/orders',customer,{inputType:'text',text:'Нужно собрать стол из готового комплекта деталей по инструкции. Нужен исполнитель со своим шуруповёртом и инструментами для сборки мебели.'});
  order.id = order.orderId;
  assert(order.id, 'Missing order ID');
  console.log(`QA order: ${order.id}`);
  await poll('order extraction',()=>request('GET',`/orders/${order.id}`,customer),v=>['allow','allow_with_warning'].includes(v.moderationStatus));
  await request('POST',`/orders/${order.id}/publish`,customer,{});
  await poll('matching',()=>request('GET','/feed?limit=50',executor),v=>v.items?.some(i=>i.orderId===order.id));
  console.log('PASS profile extraction/apply/order/publish/matching');
  const response = await request('POST',`/orders/${order.id}/responses`,executor,{});
  await request('POST',`/orders/${order.id}/contact-unlocks`,customer,{responseId:response.id});
  const assignment = await request('POST',`/orders/${order.id}/assignments`,customer,{responseId:response.id});
  assert.equal(assignment.status,'selected');
  assert.equal((await request('GET',`/orders/${order.id}`,customer)).status,'negotiating');
  const path = `/orders/${order.id}/assignments/${assignment.id}`;
  await request('POST',`${path}/start`,customer,{});
  assert.equal((await request('GET',`/orders/${order.id}`,customer)).status,'in_progress');
  await request('POST',`${path}/complete`,customer,{});
  assert.equal((await request('GET',`/orders/${order.id}`,customer)).status,'completed');
  for (const token of tokens) {
    assert.equal((await request('GET',`/orders/${order.id}/rating`,token)).pending,true);
    await request('POST',`/orders/${order.id}/rating`,token,{rating:5});
    assert.equal((await request('GET',`/orders/${order.id}/rating`,token)).pending,false);
  }
  const mine = await request('GET','/my/orders?limit=50',customer);
  const responses = await request('GET','/my/responses?limit=50',executor);
  assert.equal(mine.items.find(i=>i.id===order.id)?.archived,true);
  assert.equal(responses.items.find(i=>i.orderId===order.id)?.archived,true);
  console.log('PASS response/negotiations/agreement/completion/bilateral ratings/archive');
  console.log('SMOKE PASS (QA records retained; no automatic deletion)');
}
main().catch(error=>{console.error(`SMOKE FAIL: ${error.message}`);process.exitCode=1;});
