// CADDY_BIN=/path/to/caddy OPENAI_SDK=/path/to/openai/index.mjs node this-file
// Uses only local listeners, synthetic credentials and a mock upstream.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bin = process.env.CADDY_BIN;
assert(bin && process.env.OPENAI_SDK, 'Set CADDY_BIN and OPENAI_SDK');
assert.match(spawnSync(bin, ['version'], {encoding:'utf8'}).stdout, /^v2\.8\.4\b/);
const { default: OpenAI, toFile } = await import(pathToFileURL(process.env.OPENAI_SDK));
const seen = [];
const upstream = http.createServer(async (req,res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  seen.push({method:req.method, url:req.url, headers:req.headers, body});
  res.setHeader('Content-Type','application/json');
  const path = req.url.split('?')[0];
  res.end(JSON.stringify(path === '/v1/models' ? {object:'list',data:[]} :
    path === '/v1/embeddings' ? {object:'list',data:[{object:'embedding',index:0,embedding:[0.1,0.2]}],model:'test',usage:{prompt_tokens:1,total_tokens:1}} :
    path === '/v1/audio/transcriptions' ? {text:'mock transcript'} :
    {id:'chat-test',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'mock'},finish_reason:'stop'}]}));
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const portProbe = http.createServer(); await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));
const port = portProbe.address().port; await new Promise(r=>portProbe.close(r));
const dir = mkdtempSync(join(tmpdir(),'ustal-relay-'));
const source = readFileSync(new URL('../relay/Caddyfile',import.meta.url),'utf8');
const config = source.replace('email {$ACME_EMAIL}','admin off\n auto_https off').replace('{$RELAY_DOMAIN}',`http://127.0.0.1:${port}`).replace('https://api.openai.com',`http://127.0.0.1:${upstream.address().port}`);
writeFileSync(join(dir,'Caddyfile'),config);
const env = {...process.env,RELAY_CLIENT_TOKEN:'test-client-token',OPENAI_API_KEY:'test-upstream-key'};
const validation = spawnSync(bin,['validate','--config',join(dir,'Caddyfile'),'--adapter','caddyfile'],{env,encoding:'utf8'});
assert.equal(validation.status,0,validation.stderr);
const child = spawn(bin,['run','--config',join(dir,'Caddyfile'),'--adapter','caddyfile'],{env,stdio:'ignore'});
let checks=0;
function request(method,path,headers={Authorization:'Bearer test-client-token'}) {
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,method,path,headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    r.on('error',reject);r.end();
  });
}
try {
  for(let i=0;i<100;i++){try{await request('GET','/health',{});break;}catch{await new Promise(r=>setTimeout(r,50));}}
  const allowed = [['POST','/v1/chat/completions'],['POST','/v1/embeddings'],['POST','/v1/audio/transcriptions'],['GET','/v1/models']];
  for(const [method,path] of allowed){
    for(const suffix of ['', '?probe=%2Fv1%2Ffiles&x=1']){
      assert.equal(await request(method,path+suffix),200);checks++;
    }
    for(const m of ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE']){
      if(m===method)continue;
      const before=seen.length;assert.equal(await request(m,path),403);assert.equal(seen.length,before);checks++;
    }
  }
  const denied=['/v1/files','/v1/responses','/v1/models/x','/v1/chat/completions/','/v1/embeddingsX','/v1//embeddings','/v1/./embeddings','/v1/files/../embeddings','/v1/%65mbeddings','/v1%2fembeddings','/%76%31/embeddings','/v1/%252e%252e/embeddings','/V1/embeddings','/v1/EMBEDDINGS','/v1/embeddings%3Ffoo','/v1/embeddings;foo','/v1/embeddings%00','/v1/embeddings%5c..%5cfiles','/v1/files?path=/v1/embeddings','/v1/%2e%2e/v1/embeddings'];
  for(const path of denied){const before=seen.length;assert.equal(await request('POST',path),403,path);assert.equal(seen.length,before);checks++;}
  for(const path of [...allowed.map(x=>x[1]),...denied]){
    for(const headers of [{},{Authorization:'Bearer wrong'},{Authorization:'bearer test-client-token'},{Authorization:['Bearer test-client-token','Bearer wrong']},{Authorization:['Bearer wrong','Bearer test-client-token']},{Authorization:['Bearer test-client-token','Bearer test-client-token']}]){
      const before=seen.length;assert.equal(await request('POST',path,headers),401,path);assert.equal(seen.length,before);checks++;
    }
  }
  const spoof={'Authorization':'Bearer test-client-token','OpenAI-Organization':'attacker-org','oPeNaI-PrOjEcT':'attacker-project','X-HTTP-Method-Override':'DELETE','X-Original-URL':'/v1/files','X-Rewrite-URL':'/v1/files'};
  assert.equal(await request('POST','/v1/embeddings',spoof),200);checks++;
  for(const [method,path] of [['DELETE','/v1/embeddings'],['POST','/v1/files'],['GET','/v1/chat/completions']]){
    const before=seen.length;
    assert.equal(await request(method,path,{...spoof,'X-HTTP-Method-Override':'POST','X-Original-URL':'/v1/embeddings'}),403);
    assert.equal(seen.length,before);checks++;
  }
  const sdk = new OpenAI({apiKey:'test-client-token',baseURL:`http://127.0.0.1:${port}/v1`,organization:'attacker-org',project:'attacker-project',maxRetries:0});
  await sdk.models.list();
  await sdk.chat.completions.create({model:'gpt-4o-mini',messages:[{role:'user',content:'test'}]});
  await sdk.embeddings.create({model:'text-embedding-3-small',input:'test',encoding_format:'float'});
  assert.equal((await sdk.audio.transcriptions.create({model:'whisper-1',file:await toFile(Buffer.from('mock audio'),'test.wav',{type:'audio/wav'})})).text,'mock transcript');checks+=4;
  for(const req of seen){
    assert.equal(req.headers.authorization,'Bearer test-upstream-key');
    assert.equal(req.headers['openai-organization'],undefined);assert.equal(req.headers['openai-project'],undefined);
    assert.equal(req.headers.host,'api.openai.com');
    assert(allowed.some(([m,p])=>m===req.method && p===req.url.split('?')[0]));
  }
  assert(seen.at(-1).headers['content-type'].startsWith('multipart/form-data;'));
  assert(seen.at(-1).body.includes('mock audio'));
  if (process.env.BASH_BIN) {
    mkdirSync(join(dir,'relay'));mkdirSync(join(dir,'scripts'));
    writeFileSync(join(dir,'relay','.env'),'RELAY_DOMAIN=relay.test\nRELAY_CLIENT_TOKEN=test-client-token\n');
    writeFileSync(join(dir,'scripts','verify-relay.sh'),readFileSync(new URL('./verify-relay.sh',import.meta.url),'utf8').replaceAll('\r\n','\n'));
    // Remap only the test hostname to this loopback listener. Run the actual verifier.
    const script = `curl() { local args=(); for arg; do case "$arg" in https://relay.test*) args+=("http://127.0.0.1:${port}\${arg#https://relay.test}");; *) args+=("$arg");; esac; done; command curl "\${args[@]}"; }; export -f curl; bash "$VERIFY_SCRIPT"`;
    const verify = spawn(process.env.BASH_BIN,['-c',script],{env:{...process.env,VERIFY_SCRIPT:join(dir,'scripts','verify-relay.sh').replaceAll('\\','/')},stdio:['ignore','pipe','pipe']});
    let output='';verify.stdout.on('data',x=>output+=x);verify.stderr.on('data',x=>output+=x);
    assert.equal(await new Promise(r=>verify.once('exit',r)),0,output);
    console.log(output.trim());checks++;
  }
  console.log(`PASS: ${checks} checks; four real SDK methods; ${seen.length} upstream requests; auth replacement and tenant-header stripping verified`);
} finally {
  child.kill(); await new Promise(r=>child.once('exit',r));
  await new Promise(r=>upstream.close(r));rmSync(dir,{recursive:true,force:true});
}
