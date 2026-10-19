import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createApp} from '../lib/app-server.mjs';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {captureRuntimeSession} from '../lib/runtime-session-state.mjs';
import {runtimeSessionContext} from '../lib/runtime-session-context.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';
import {accountLibrarySession} from '../lib/account-library.mjs';
import {WPLAY_AUTH_URLS} from '../lib/wplay/conexao/autenticacao.mjs';

const cookie='R'.repeat(32),sessionHash=createHash('sha256').update(cookie).digest('hex');
const providerKey='a'.repeat(64),scopeHash='b'.repeat(64);
class ResponseFixture extends EventEmitter{
  constructor(){super();this.headers=new Map();this.statusCode=200;this.headersSent=false;this.destroyed=false;this.body=[];}
  setHeader(name,value){this.headers.set(name.toLowerCase(),value);return this;}
  getHeader(name){return this.headers.get(name.toLowerCase());}
  getHeaders(){return Object.fromEntries(this.headers);}
  getHeaderNames(){return [...this.headers.keys()];}
  removeHeader(name){this.headers.delete(name.toLowerCase());}
  writeHead(status,headers={}){this.statusCode=status;for(const [name,value]of Object.entries(headers))this.setHeader(name,value);this.headersSent=true;return this;}
  write(value){if(value!==undefined)this.body.push(Buffer.from(value));this.headersSent=true;return true;}
  end(value){this.write(value);return this;}
  json(){return JSON.parse(Buffer.concat(this.body).toString());}
}

async function fixture(t,{disabled=false}={}){
  const now=Date.now(),calls=[],row={cipher:null,mediaEpoch:null,revision:0,fence:0,owner:null};
  const config={server:WPLAY_AUTH_URLS[1],username:'synthetic-revision',password:'synthetic-password'};
  const makeClient=configuration=>({config:configuration,libraryProvider:'wplay',authenticatedAt:now,playbackGeneration:0,playback:null,
    session:{connected:true,account:{status:disabled?'Disabled':'Active',expiresAt:'2070-01-01T00:00:00Z'}},
    connect:()=>assert.fail('Revision renewal must not log into WPLAY'),
    exportRuntimeState(){return {config:this.config,session:this.session,authenticatedAt:this.authenticatedAt,playbackGeneration:this.playbackGeneration};},
    restoreRuntimeState(value){Object.assign(this,value);},
  });
  const client=makeClient(config);client.session=accountLibrarySession(client.session,config,'wplay');
  const previousCloud={providerKey,scopeHash,libraryId:client.session.account.libraryId,session:{access_token:'synthetic-expired'}};
  const state={client,authGeneration:4,loggedOut:false,seen:now,attempts:[],parental:new ParentalControl(),
    cloud:previousCloud,cloudClient:client,cloudExpiresAt:now-1,cloudStatus:{state:'ready'}};
  state.parental.rememberCatalog({categories:[{id:'adult',name:'Adultos +18'}],items:[{id:'9',kind:'movie',categoryId:'adult'}]},'movies');
  const cloud={enabled:true,ready:Promise.resolve(true),publicConfig:()=>({}),runtimeSessionKey:()=>Buffer.alloc(32,31),
    async bootstrap(){
      assert.equal(runtimeSessionContext().readOnly,false);
      calls.push('bootstrap');return {...previousCloud,session:{access_token:'synthetic-renewed',expires_in:3600}};
    },
    async revoke(){calls.push('revoke');},async rpc(){calls.push('domain-rpc');},
    async request(path,options){
      calls.push('revision-read');assert.match(path,/^\/rest\/v1\/provider_catalog_cache\?/);
      assert.equal(options.accessToken,'synthetic-renewed');assert.equal(runtimeSessionContext().readOnly,true);
      return [{is_complete:true,snapshot_id:'11111111-1111-4111-8111-111111111111',index_generation:'22222222-2222-4222-8222-222222222222',
        item_count:1,safe_item_count:1,updated_at:new Date(now).toISOString(),expires_at:'2070-01-01T00:00:00Z'}];
    },
    async runtimeSessionRPC(operation,args){
      calls.push(operation);
      if(operation==='read')return row.cipher?{cipher:row.cipher,mediaEpoch:row.mediaEpoch,revision:row.revision}:{missing:true};
      if(operation==='media')return {ok:row.mediaEpoch===args.p_media_epoch};
      if(operation==='acquire'){
        assert.equal(row.owner,null);row.owner=args.p_owner;row.fence++;
        return {...row,leaseUntil:new Date(Date.now()+90000).toISOString()};
      }
      assert.equal(operation,'commit');assert.equal(args.p_owner,row.owner);assert.equal(args.p_fence,row.fence);assert.equal(args.p_revision,row.revision);
      if(args.p_cipher!==null){row.cipher=args.p_cipher;row.revision++;}
      row.mediaEpoch=args.p_media_epoch;if(args.p_release)row.owner=null;
      return {ok:true,revision:row.revision,fence:row.fence};
    },
  };
  const store=new RuntimeSessionStore({cloud});
  await store.run({headers:{cookie:'ORBIT_SID='+cookie},aborted:false},new ResponseFixture(),{
    createState:()=>state,capture:captureRuntimeSession,restore:()=>state,
  },async()=>{});
  calls.length=0;
  const app=createApp({connection:{server:config.server},environment:{},cloud,sessionStore:store,
    providerFactory:({config})=>makeClient(config)});
  t.after(()=>app.shutdown());
  const request=async type=>{
    const req=new EventEmitter();Object.assign(req,{method:'GET',url:'/api/catalog/revision?type='+type,
      headers:{host:'127.0.0.1',cookie:'ORBIT_SID='+cookie},aborted:false});
    const res=new ResponseFixture();await app.listeners('request')[0](req,res);return res;
  };
  return {calls,row,store,request};
}

test('hosted revision renews an expired cloud token under its writer fence, commits it and then serves a fresh reader',async t=>{
  const f=await fixture(t),first=await f.request('movies');
  assert.equal(first.statusCode,200);assert.equal(first.json().complete,true);assert.equal(first.json().includeAdult,false);
  assert.equal(f.calls.filter(value=>value==='bootstrap').length,1);assert.ok(f.calls.indexOf('commit')<f.calls.indexOf('revision-read'));
  assert.equal(f.row.owner,null);
  const dto=await f.store.openCipher(f.row.cipher,sessionHash);
  assert.equal(dto.cloud.session.access_token,'synthetic-renewed');assert.ok(dto.cloudExpiresAt>Date.now()+60000);
  const parental=new ParentalControl().restoreRuntimeState(dto.parental);
  assert.throws(()=>parental.assertPlayback('movie','9'),{code:'PARENTAL_LOCKED'});
  f.calls.length=0;
  const second=await f.request('series');assert.equal(second.statusCode,200);assert.equal(second.json().mediaType,'series');
  assert.equal(f.calls.includes('acquire'),false);assert.equal(f.calls.includes('bootstrap'),false);
  assert.ok(f.calls.includes('read'));assert.ok(f.calls.includes('media'));assert.equal(f.row.owner,null);
});

test('hosted revision never renews or reads global metadata for a disabled provider account',async t=>{
  const f=await fixture(t,{disabled:true}),response=await f.request('live');
  assert.equal(response.statusCode,401);assert.equal(response.json().code,'CLOUD_PROVIDER_VALIDATION_REQUIRED');
  assert.equal(f.calls.includes('bootstrap'),false);assert.equal(f.calls.includes('revision-read'),false);assert.equal(f.row.owner,null);
});
