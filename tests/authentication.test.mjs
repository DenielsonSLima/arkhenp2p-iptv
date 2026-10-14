import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../lib/app-server.mjs';

async function fixture(){
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  const requests=[];
  const provider=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');const username=url.searchParams.get('username');requests.push(username);
    if(username==='slow-1111'){entered();await gate;}
    if(username==='http-rejected'){res.writeHead(401).end();return;}
    const user_info={auth:username==='rejected'?0:1,status:username==='inactive'?'Expired':'Active',exp_date:String(Math.floor(Date.now()/1000)+(username==='expired'?-86400:86400)),max_connections:'1'};
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({user_info}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const app=createApp({connection:{server:`http://127.0.0.1:${provider.address().port}`},allowPrivateUpstream:true});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.address().port}`;
  const initial=await fetch(base+'/api/session'),cookie=initial.headers.get('set-cookie').split(';')[0];
  const login=value=>fetch(base+'/api/login',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({provider:"xtream",...value})});
  return{base,cookie,requests,login,release,waiting,session:async()=>await(await fetch(base+'/api/session',{headers:{Cookie:cookie}})).json(),logout:()=>fetch(base+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:base},body:'{}'}),async close(){release();for(const server of [app,provider]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}};
}

test('wrong credentials and inactive subscriptions are distinguished from gateway failures',async()=>{
  const mock=await fixture();
  try{
    for(const username of ['rejected','http-rejected']){
      const response=await mock.login({username,password:'synthetic-secret'});assert.equal(response.status,401);
      const body=await response.json();assert.equal(body.code,'AUTH_REJECTED');assert.ok(!JSON.stringify(body).includes('synthetic-secret'));
    }
    for(const [username,code]of [['inactive','ACCOUNT_INACTIVE'],['expired','ACCOUNT_EXPIRED']]){
      const response=await mock.login({username,password:'synthetic-secret'});assert.equal(response.status,403);assert.equal((await response.json()).code,code);
    }
    const invalid=await mock.login({server:'javascript:alert(1)',username:'good-2222',password:'synthetic-secret'});assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'INVALID_CONNECTION');
    assert.equal((await mock.session()).connected,false);
  }finally{await mock.close();}
});

test('logging out cancels an authentication that is still waiting for the provider',async()=>{
  const mock=await fixture();
  try{
    const pending=mock.login({username:'slow-1111',password:'synthetic-secret'});await mock.waiting;
    assert.equal((await mock.logout()).status,200);mock.release();
    const response=await pending;assert.equal(response.status,409);assert.equal((await response.json()).code,'LOGIN_CANCELLED');
    assert.equal((await mock.session()).connected,false);
  }finally{await mock.close();}
});

test('a late first login cannot replace a more recent successful account',async()=>{
  const mock=await fixture();
  try{
    const old=mock.login({username:'slow-1111',password:'synthetic-secret'});await mock.waiting;
    const latest=await mock.login({username:'good-2222',password:'synthetic-secret'});assert.equal(latest.status,200);await latest.json();
    mock.release();assert.equal((await old).status,409);
    assert.equal((await mock.session()).account.usernameMasked,'••••2222');
  }finally{await mock.close();}
});
