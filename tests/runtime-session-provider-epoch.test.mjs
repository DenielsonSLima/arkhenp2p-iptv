import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RuntimeSessionStore} from '../lib/runtime-session-store.mjs';
import {captureRuntimeSession,restoreRuntimeSession} from '../lib/runtime-session-state.mjs';
import {ParentalControl} from '../lib/parental-control.mjs';
import {OrquestradorConexaoWplay} from '../lib/wplay/orquestrador.mjs';
import {reservePlaybackIntent} from '../lib/live-playback-session.mjs';
import {runtimeSessionContext} from '../lib/runtime-session-context.mjs';

const cookie='E'.repeat(32),sessionHash=createHash('sha256').update(cookie).digest('hex');
const request=()=>({headers:{cookie:'ORBIT_SID='+cookie},aborted:false});
const fresh=()=>({client:null,loggedOut:false,authGeneration:0,seen:Date.now(),attempts:[],parental:new ParentalControl()});
const epochFields=state=>{
  const client=state.client,playback=client.playback,active=playback&&!playback.controller.signal.aborted;
  return [state.authGeneration,client.libraryProvider,client.config.server,client.config.username,
    client.session.account.status,client.session.account.expiresAt??null,state.parental.unlocked===true,
    client.playbackGeneration,active?playback.key:null,active?state.playbackIntent?.attempt||'':null];
};
class ResponseFixture{
  constructor(){this.headers=new Map();this.statusCode=200;this.headersSent=false;this.destroyed=false;this.chunks=[];}
  getHeaders(){return Object.fromEntries(this.headers);}
  getHeaderNames(){return [...this.headers.keys()];}
  setHeader(name,value){this.headers.set(name.toLowerCase(),value);return this;}
  removeHeader(name){this.headers.delete(name.toLowerCase());}
  writeHead(status,headers={}){this.statusCode=status;for(const[name,value]of Object.entries(headers))this.setHeader(name,value);this.headersSent=true;return this;}
  write(chunk){if(chunk!==undefined)this.chunks.push(Buffer.from(chunk));this.headersSent=true;return true;}
  end(chunk){if(chunk!==undefined)this.chunks.push(Buffer.from(chunk));this.headersSent=true;return this;}
  json(){return JSON.parse(Buffer.concat(this.chunks).toString());}
}
class CloudFixture{
  constructor(){this.row=null;this.calls=[];}
  runtimeSessionKey(){return Buffer.alloc(32,31);}
  async runtimeSessionRPC(operation,args){
    assert.equal(args.p_session_hash,sessionHash);this.calls.push(operation);const now=Date.now();
    if(operation==='read')return this.row?.cipher?{cipher:this.row.cipher,revision:this.row.revision,mediaEpoch:this.row.mediaEpoch,expiresAt:new Date(now+86400000).toISOString()}:{missing:true};
    if(operation==='media')return {ok:this.row?.mediaEpoch===args.p_media_epoch};
    if(operation==='acquire'){
      if(!this.row){if(!args.p_create)return {missing:true};this.row={cipher:null,revision:0,fence:0,owner:null,leaseUntil:0};}
      if(this.row.owner&&this.row.owner!==args.p_owner&&this.row.leaseUntil>now)return {busy:true,retryAfterMs:250};
      this.row.owner=args.p_owner;this.row.fence++;this.row.leaseUntil=now+90000;
      return {cipher:this.row.cipher,revision:this.row.revision,fence:this.row.fence,leaseUntil:new Date(this.row.leaseUntil).toISOString()};
    }
    const row=this.row;
    if(!row||row.owner!==args.p_owner||row.fence!==args.p_fence||row.leaseUntil<=now)return {ok:false,conflict:true};
    if(operation==='renew'){row.leaseUntil=now+90000;return {ok:true,leaseUntil:new Date(row.leaseUntil).toISOString()};}
    assert.equal(operation,'commit');if(row.revision!==args.p_revision)return {ok:false,conflict:true};
    if(args.p_cipher!=null&&args.p_cipher!==row.cipher){row.cipher=args.p_cipher;row.revision++;}
    row.mediaEpoch=args.p_media_epoch;
    if(args.p_release){row.owner=null;row.leaseUntil=0;}else row.leaseUntil=now+90000;
    return {ok:true,revision:row.revision,fence:row.fence};
  }
}
const factory=new OrquestradorConexaoWplay();
const createClient=async({provider,config})=>{
  const resolved=factory.resolveConnection({provider,...config});
  return factory.createClient({...resolved,config:{...resolved.config,...config}});
};
const settings={createState:fresh,capture:captureRuntimeSession,restore:dto=>restoreRuntimeSession(dto,{createState:fresh,createClient})};
const reply=(res,value)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};

test('real provider snapshots preserve every authorization/media epoch field through writer and direct-reader stores',async t=>{
  for(const provider of ['xtream','wplay','wplay-ott'])for(const mode of ['idle','live','series'])for(const unlocked of [false,true]){
    await t.test(`${provider} ${mode} PIN ${unlocked?'unlocked':'locked'}`,async()=>{
      const cloud=new CloudFixture(),writer=new RuntimeSessionStore({cloud});let expected;
      await writer.run(request(),new ResponseFixture(),{...settings,create:true},async state=>{
        state.client=await createClient({provider,config:{server:provider==='wplay-ott'?'https://player.wplayott.com':'https://provider.fixture.invalid/base/',username:' fixture-user ',password:'fixture-only'}});
        const client=state.client;client.libraryProvider=provider;client.authenticatedAt=Date.now();
        client.session={connected:true,account:{status:'Active',expiresAt:unlocked?'2030-01-02T03:04:05.000Z':null}};
        state.authGeneration=mode==='idle'?0:7;state.parental.unlocked=unlocked;
        if(provider==='wplay')client.authInfo={service:{token:'fixture-only',enabledLive:true}};
        if(mode!=='idle'){
          client.playbackGeneration=10;
          reservePlaybackIntent(state,client,{kind:mode,id:'101',attempt:'fixture-attempt-101'});client.beginPlayback(mode+':101');
          if(provider==='wplay'){
            const dto=client.exportRuntimeState();
            dto.playbackRuntime={...dto.playbackRuntime,selectionGeneration:11,pending:false,selection:{key:mode+':101',attempt:'fixture-attempt-101',selector:'auto',sourceId:null,
              generation:11,url:'https://media.fixture.invalid/'+mode+'/101.m3u8',transport:'http',aborted:false}};
            client.restoreRuntimeState(dto);
          }
          if(provider==='wplay-ott'&&mode==='live'){
            client.liveSource={key:'live:101',attempt:'fixture-attempt-101',selector:'auto',url:'https://player.wplayott.com/fixture.m3u8',generation:3};
            client.liveGeneration=3;
          }
        }
        expected=epochFields(state);
      });
      assert.match(cloud.row.mediaEpoch,/^[a-f0-9]{64}$/);
      const committedCipher=cloud.row.cipher,committedEpoch=cloud.row.mediaEpoch,revision=cloud.row.revision;
      const revived=await settings.restore(await writer.openCipher(committedCipher,sessionHash));
      assert.deepEqual(epochFields(revived),expected,'DTO round trip changed an epoch input');
      cloud.calls=[];let captures=0;
      for(let pass=0;pass<2;pass++){
        const response=new ResponseFixture();
        await new RuntimeSessionStore({cloud}).run(request(),response,{...settings,readOnly:true,capture:()=>{captures++;assert.fail('Direct reader captured mutable state');}},async state=>{
          assert.equal(runtimeSessionContext().readOnly,true);runtimeSessionContext().assert();
          assert.deepEqual(epochFields(state),expected);reply(response,{provider,mode,unlocked});
        });
        assert.deepEqual(response.json(),{provider,mode,unlocked});
      }
      assert.equal(captures,0);assert.deepEqual(cloud.calls,['read','media','read','media']);
      assert.equal(cloud.row.cipher,committedCipher);assert.equal(cloud.row.mediaEpoch,committedEpoch);assert.equal(cloud.row.revision,revision);
    });
  }
});
