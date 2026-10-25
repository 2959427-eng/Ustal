import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { deletionClient } from "./account-deletion.js";

function harness(responses: Array<{status:number; data?:unknown} | Error>) {
  const nodes = new Map<string, any>(); const calls: Array<{url:string; options:any}>=[];
  const get=(id:string)=>{
    if(!nodes.has(id)) nodes.set(id,{value:'',checked:false,hidden:id==='account',textContent:'',disabled:false,listeners:{},setAttribute(){},addEventListener(event:string,fn:any){this.listeners[event]=fn;}});
    return nodes.get(id);
  };
  vm.runInNewContext(deletionClient,{
    document:{getElementById:get},window:{addEventListener(){}},AbortController,setTimeout,clearTimeout,
    fetch:async(url:string,options:any)=>{calls.push({url,options});const r=responses.shift(); if(r instanceof Error) throw r; if(!r) throw Error('unexpected fetch');return{status:r.status,ok:r.status>=200&&r.status<300,json:async()=>r.data};},
  });
  const submit=(id:string)=>get(id).listeners.submit({preventDefault(){}});
  const login=async()=>{get('phone').value='+79990000000';get('login-password').value='first-secret';await submit('login-form');};
  return{get,calls,submit,login};
}
const session={status:200,data:{accessToken:'access',refreshToken:'refresh',userId:'id'}};
const me={status:200,data:{id:'id',name:'<img src=x>',phone:'+79990000000'}};
describe('browser deletion API contract',()=>{
  it('requires explicit second password and confirms only204; no storage/redirect credentials',async()=>{
    const h=harness([session,me,{status:204}]);await h.login();
    expect(h.get('identity').textContent).toContain('<img src=x>');
    expect(h.get('login-password').value).toBe('');
    await h.submit('delete-form');expect(h.calls).toHaveLength(2);
    h.get('delete-password').value='second-secret';h.get('confirm').checked=true;
    const p=h.submit('delete-form');const duplicate=h.submit('delete-form');expect(h.get('delete').disabled).toBe(true);await Promise.all([p,duplicate]);
    expect(h.calls.map(c=>c.url)).toEqual(['/auth/login','/me','/me']);
    expect(JSON.parse(h.calls[2]!.options.body)).toEqual({password:'second-secret'});
    expect(h.calls.every(c=>c.options.credentials==='omit'&&c.options.redirect==='error')).toBe(true);
    expect(h.get('status').textContent).toContain('Сервер подтвердил');expect(h.get('identity').textContent).toBe('');
  });
  for(const code of [403,409,429,500,401]) it(`does not report deletion success on${code}`,async()=>{
    const h=harness([session,me,{status:code}]);await h.login();h.get('delete-password').value='secret';h.get('confirm').checked=true;
    await h.submit('delete-form');expect(h.get('status').textContent).not.toContain('Сервер подтвердил');
    expect(h.get('delete').disabled).toBe(false);expect(h.get('delete-password').value).toBe('');
    if(code===401) expect(h.get('account').hidden).toBe(true);
  });
  it('network uncertainty clears session, revokes own refresh and never retriesDELETE',async()=>{
    const h=harness([session,me,new Error('timeout'),{status:204}]);await h.login();h.get('delete-password').value='secret';h.get('confirm').checked=true;
    await h.submit('delete-form');expect(h.get('status').textContent).toContain('результат удаления неизвестен');
    expect(h.get('account').hidden).toBe(true);expect(h.calls.filter(c=>c.options.method==='DELETE')).toHaveLength(1);
    expect(h.calls[3]!.url).toBe('/auth/logout');expect(JSON.parse(h.calls[3]!.options.body)).toEqual({refreshToken:'refresh'});
  });
  it('rejects identity mismatch and ends only its own temporary session',async()=>{
    const h=harness([session,{status:200,data:{...me.data,id:'different'}},{status:204}]);await h.login();
    expect(h.get('account').hidden).not.toBe(false);expect(h.calls.at(-1)!.url).toBe('/auth/logout');
  });
});
