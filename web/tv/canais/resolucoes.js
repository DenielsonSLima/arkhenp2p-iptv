import {sourceDecodingConfiguration} from '../../channel-variants.js';
const QUALITY_RANK={SD:480,HD:720,FHD:1080,UHD:2160,'4K':2160,'8K':4320,'480P':480,'576P':576,'720P':720,'1080P':1080,'1440P':1440,'2160P':2160,'4320P':4320};
const positive=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):0;
const idOf=source=>String(source?.id??'');
export function declaredLiveSourceRank(source){
  const height=positive(source?.declaredHeight);if(height)return height;
  return QUALITY_RANK[String(source?.quality||'').toUpperCase()]||0;
}
export function liveSourceOptions(sources=[]){
  const seen=new Set();return (Array.isArray(sources)?sources:[]).filter(source=>{
    const id=idOf(source);if(!/^[A-Za-z0-9_-]{1,100}$/.test(id)||seen.has(id))return false;seen.add(id);return true;
  }).map(source=>({...source,id:idOf(source)})).sort((a,b)=>declaredLiveSourceRank(b)-declaredLiveSourceRank(a));
}
export function highestLiveSource(sources){return liveSourceOptions(sources).find(source=>source.available!==false)||null;}
export function hlsLevelSupported(level){
  const mediaSource=globalThis.MediaSource||globalThis.ManagedMediaSource,codec=level?.videoCodec;
  if(!codec||typeof mediaSource?.isTypeSupported!=='function')return null;
  try{return mediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`);}catch{return null;}
}
export function highestHlsLevel(levels=[]){
  return levels.map((level,index)=>({level,index})).filter(({level})=>hlsLevelSupported(level)!==false).sort((a,b)=>positive(b.level.height)-positive(a.level.height)
    ||positive(b.level.bitrate)-positive(a.level.bitrate)||positive(b.level.frameRate)-positive(a.level.frameRate))[0]?.index??-1;
}
export function lowestHlsLevel(levels=[]){
  return levels.map((level,index)=>({level,index})).filter(({level})=>hlsLevelSupported(level)!==false).sort((a,b)=>positive(a.level.height)-positive(b.level.height)
    ||positive(a.level.bitrate)-positive(b.level.bitrate))[0]?.index??-1;
}
export function blockedSourceFailure({status,code}={}){
  return [401,403,409,429].includes(Number(status))||/AUTH|ACCOUNT|PARENTAL|SESSION|STOP|CERTIFICATION|RATE_LIMIT|CATALOG|^ENGINE_|^NATIVE_BRIDGE_|^NATIVE_ACCOUNT_|^EXTERNAL_|PLAYBACK_CANCELLED|LIVE_SOURCE_CHANGED|WPLAY_WEB_(?:UNAVAILABLE|START_TIMEOUT|CHANNEL_)|OTT_SERVICE_UNAVAILABLE/.test(String(code||''));
}
export function createLiveSourceState({sourceId='',now=0}={}){
  return {sourceId:String(sourceId),visited:sourceId?[String(sourceId)]:[],switches:0,lastSwitchAt:null,stallTimes:[],lastStalls:0,pendingId:null,observedAt:now};
}
/** One opening may descend at most twice, never revisiting a failed source. */
export function decideLiveSourceFallback({state,sources,sourceId,now,enabled=true,reason='repeated-stalls',bufferSeconds=0,stalls=0,started=false,mediaReadyAt=null,status,code}={}){
  const next=state?{...state,visited:[...(state.visited||[])],stallTimes:[...(state.stallTimes||[])]}:createLiveSourceState({sourceId,now});
  const result=(why,target=null)=>({state:next,target,reason:why});
  if(!Number.isFinite(now)||!enabled||blockedSourceFailure({status,code}))return result('blocked');
  sourceId=String(sourceId||'');
  if(next.sourceId!==sourceId){next.sourceId=sourceId;next.pendingId=null;next.lastStalls=0;next.stallTimes=[];}
  if(sourceId&&!next.visited.includes(sourceId))next.visited.push(sourceId);
  if(next.pendingId||next.switches>=2||next.lastSwitchAt!==null&&now-next.lastSwitchAt<3000)return result('budget-or-cooldown');
  const observed=Number.isSafeInteger(stalls)&&stalls>=0?stalls:0;
  if(now<next.observedAt||now-next.observedAt>30000||observed<next.lastStalls)next.stallTimes=[];
  if(observed>next.lastStalls)next.stallTimes.push(...Array(Math.min(2,observed-next.lastStalls)).fill(now));
  next.lastStalls=observed;next.observedAt=now;next.stallTimes=next.stallTimes.filter(time=>now-time<=30000);
  if(reason==='repeated-stalls'&&(!started||bufferSeconds>=2||next.stallTimes.length<2))return result('holding');
  if(reason==='startup-slow'&&(started||!Number.isFinite(mediaReadyAt)||now-mediaReadyAt<10000))return result('preparing');
  const offered=liveSourceOptions(sources).filter(source=>source.available!==false),current=offered.find(source=>source.id===sourceId),rank=declaredLiveSourceRank(current);
  let candidates=offered.filter(source=>source.id!==sourceId&&!next.visited.includes(source.id)&&(!rank||declaredLiveSourceRank(source)<rank));
  if(!candidates.length)candidates=offered.filter(source=>source.id!==sourceId&&!next.visited.includes(source.id)&&declaredLiveSourceRank(source)===rank);
  const target=candidates[0];if(!target)return result('no-lower-source');
  next.switches++;next.lastSwitchAt=now;next.pendingId=target.id;next.visited.push(target.id);next.stallTimes=[];
  return result(reason,target);
}

export function selectTVSource(tools,source,options={}){
    const current=tools.current,target=current?.sources.find(candidate=>candidate.id===source?.id&&candidate.available!==false&&current.sourceCapabilities.get(candidate.id)!==false);
    if(!target||!current.onSourceChange||current.sourceSwitchPending)return false;
    current.sourceSwitchPending=true;
    const automatic=options.automatic===true;if(!automatic)current.qualityMode=options.qualityMode==='auto'?'auto':'manual';
    current.onSourceChange(target,{sourceId:target.id,automatic,qualityMode:automatic?'auto':current.qualityMode,adaptiveState:tools.adaptiveState,reason:options.reason||'manual-source'});return true;
}

export function prepareTVHlsStartup(tools){
    const current=tools.current,hls=current?.hls;if(!hls||current.item.kind!=='live'||current.hlsStartupApplied||!hls.levels?.length)return;
    current.hlsStartupApplied=true;
    const automatic=tools.autoQuality&&current.qualityMode!=='manual';let index;
    if(automatic)index=highestHlsLevel(hls.levels);
    else if(Number.isInteger(current.forcedLevel)&&current.forcedLevel>=0&&current.forcedLevel<hls.levels.length)index=current.forcedLevel;
    else if(current.manualHeight)index=hls.levels.findIndex(level=>level.height===current.manualHeight);
    if(!Number.isInteger(index)||index<0)index=Math.max(0,Math.min(hls.levels.length-1,Number.isInteger(hls.firstLevel)?hls.firstLevel:0));
    hls.startLevel=index;
    if(automatic)hls.loadLevel=-1;else{current.forcedLevel=index;hls.loadLevel=index;}
    hls.startLoad();
}

export function tryTVSourceFallback(tools,reason='source-error',{status,code}={},bufferSeconds){
    const current=tools.current;
    if(!current||current.item.kind!=='live'||current.failed||current.sourceSwitchPending||!current.onSourceChange||current.sources.length<2||current.sourceFallbackBlocked||current.rateLimitedUntil>Date.now())return false;
    const sources=current.sources.map(source=>current.sourceCapabilities.get(source.id)===false?{...source,available:false}:source);
    const decision=decideLiveSourceFallback({state:current.sourceState,sources,sourceId:current.sourceId,now:Date.now(),
      enabled:tools.autoQuality&&current.qualityMode!=='manual',reason,bufferSeconds:bufferSeconds(tools.video),stalls:current.stalls,started:current.started,mediaReadyAt:current.mediaReadyAt,status,code});
    current.sourceState=decision.state;tools.adaptiveState.liveSourceState=decision.state;
    if(!decision.target)return false;
    tools.options.toast('Fonte ajustada para recuperar a estabilidade.');
    return tools.selectLiveSource(decision.target,{automatic:true,reason:decision.reason});
}

export async function inspectTVSourceCapabilities(tools,current){
    const capabilities=globalThis.navigator?.mediaCapabilities;if(!capabilities?.decodingInfo || current.item.kind!=='live')return;
    await Promise.allSettled(current.variants.slice(0,64).map(async item=>{
      const configuration=sourceDecodingConfiguration(item,current.hls?'media-source':'file');if(!configuration)return;
      const result=await capabilities.decodingInfo(configuration);if(tools.current!==current)return;
      current.sourceCapabilities.set(String(item.id),result.supported===true&&result.smooth===true);tools.updateMetrics();
    }));
    await Promise.allSettled(current.sources.slice(0,64).map(async source=>{
      const item={source:{width:source.declaredWidth,height:source.declaredHeight,videoCodec:source.videoCodec,frameRate:source.frameRate,bitrateBps:source.bitrateBps}};
      const configuration=sourceDecodingConfiguration(item,current.hls?'media-source':'file');if(!configuration)return;
      const result=await capabilities.decodingInfo(configuration);if(tools.current!==current)return;
      current.sourceCapabilities.set(source.id,result.supported===true&&result.smooth===true);tools.renderQuality();tools.updateMetrics();
    }));
}
