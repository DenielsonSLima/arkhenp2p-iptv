import {resumePlaybackPosition,continuedPlaybackPosition} from '../playback-position.js';
import {isAdultItem} from '../parental-classification.js';
import {cloudItem} from '../cloud-library-records.js';

const seconds=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const scopeKey=value=>{
  const account=value?.account||value?.libraryId;if(typeof account!=='string'||!account)return null;
  return JSON.stringify([account,value.epoch??value.generation??0,value.project||value.url||'',value.providerKey||'',value.scopeHash||'',value.includeAdult===true]);
};
const qualityOptions=value=>({qualityMode:value?.qualityMode==='manual'?'manual':'auto',qualityHeight:Number.isSafeInteger(value?.qualityHeight)&&value.qualityHeight>0?value.qualityHeight:null});
export function movieRecoveryBlocked({status,code,retryAfterUntil=0,now=Date.now()}={}){
  return retryAfterUntil>now||[401,403,409,429].includes(Number(status))||
    /AUTH|ACCOUNT|PARENTAL|SESSION|STOP|RATE_LIMIT|CERTIFICATION|PLAYBACK_CANCELLED|^ENGINE_|^NATIVE_|^EXTERNAL_|^WPLAY_WEB_/.test(String(code||''));
}

/** Movie resume/metadata policy over the single shared video, seek controller,
 * position guard and prompt. It never assigns src, creates HLS, requests media,
 * persists history or owns the provider stop/connection lifecycle. */
export class MoviePlayback{
  constructor({video,vodSeek,positionGuard,resumePrompt,getScope=()=>null,serializeItem=cloudItem,canRemember=()=>true,now=Date.now}={}){
    if(!video||!vodSeek||!positionGuard||!resumePrompt)throw new TypeError('Filmes requer os controladores compartilhados de reprodução.');
    Object.assign(this,{video,vodSeek,positionGuard,resumePrompt,getScope,serializeItem,canRemember,now});
    this.session=null;this.metadataCleanup=null;
  }
  #current(ticket=this.session){
    try{return Boolean(ticket&&this.session===ticket&&ticket.scope===scopeKey(this.getScope())&&ticket.isCurrent());}catch{return false;}
  }
  attach({item,historyEntry,accountLibraryId,playOptions={},categories=[],sourceKey,isCurrent=()=>true,onReady=()=>{},playNow=()=>{}}={}){
    this.reset();const scope=this.getScope(),encoded=scopeKey(scope),account=scope?.account||scope?.libraryId;
    if(item?.kind!=='movie'||!encoded||accountLibraryId&&accountLibraryId!==account||!isCurrent())return null;
    const resumeTime=resumePlaybackPosition({item,historyEntry,accountLibraryId:account,options:playOptions,categories});
    const ticket={item,scope:encoded,account,options:{...playOptions},categories,isCurrent,sourceKey:sourceKey||`movie:${item.id}:`,resumeTime,ready:false,completed:false};
    this.session=ticket;
    this.positionGuard.attach({resumeTime});
    this.vodSeek.attach({kind:'movie',sourceKey:ticket.sourceKey,recoveryAttempt:playOptions.seekRecoveryAttempt||0});
    this.resumePrompt.attach({time:playOptions.seekRecoveryAttempt?0:resumeTime});
    const cleanup=()=>{this.video.removeEventListener('loadedmetadata',start);if(this.metadataCleanup===cleanup)this.metadataCleanup=null;};
    const start=()=>{
      cleanup();if(!this.#current(ticket))return;ticket.ready=true;onReady({resumeTime});
      if(!this.#current(ticket))return;
      if(resumeTime>0)this.vodSeek.request(resumeTime,{play:playOptions.resumePlay!==false,reason:playOptions.seekRecoveryAttempt?'recovery':'resume'});
      if(this.#current(ticket)&&playOptions.resumePlay!==false)playNow();
    };
    this.metadataCleanup=cleanup;this.video.addEventListener('loadedmetadata',start,{once:true});
    return {resumeTime,sourceKey:ticket.sourceKey,cleanup};
  }
  continuation({seekTarget}={}){
    const ticket=this.session;if(!this.#current(ticket))return {};
    return {resumeTime:continuedPlaybackPosition({seekTarget,resumePending:this.positionGuard.pending,resumeTarget:this.positionGuard.target,currentTime:this.video.currentTime}),
      resumePlay:this.vodSeek.pending?.play??!this.video.paused,startFromBeginning:false,seekRecoveryAttempt:ticket.options.seekRecoveryAttempt||0};
  }
  recoveryOptions({target,play,sourceKey,recoveryAttempt}={}, {quality,retryAfterUntil,status,code,failed=false}={}){
    const ticket=this.session;
    if(failed||!this.#current(ticket)||ticket.sourceKey!==sourceKey||!seconds(target)||recoveryAttempt!==1||
      movieRecoveryBlocked({status,code,retryAfterUntil,now:this.now()}))return null;
    return {...ticket.options,...qualityOptions(quality),route:false,resumeTime:target,resumePlay:Boolean(play),seekRecoveryAttempt:1,startFromBeginning:false};
  }
  progress({force=false,completed=false,mediaReady=this.session?.ready,lastSavedAt=0}={}){
    const ticket=this.session,time=this.video.currentTime,now=this.now();
    if(!this.#current(ticket)||!ticket.ready||!mediaReady||!seconds(time)||!this.positionGuard.canSave(time)||
      !this.canRemember(ticket.item)||isAdultItem(ticket.item,ticket.categories)||!force&&(time<3||now-lastSavedAt<5000))return null;
    const item=this.serializeItem(ticket.item);if(!item)return null;
    ticket.completed ||= completed||this.video.ended===true;
    return {item:{...item,libraryId:ticket.account},time,duration:Number.isFinite(this.video.duration)&&this.video.duration>0?this.video.duration:0,
      episode:null,completed:ticket.completed,updated:now,libraryId:ticket.account};
  }
  detachMetadata(){this.metadataCleanup?.();this.metadataCleanup=null;}
  reset(){this.detachMetadata();this.session=null;}
  dispose(){this.reset();}
}
