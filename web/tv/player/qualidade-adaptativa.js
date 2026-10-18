import {channelCodec} from '../../channel-variants.js';
import {declaredLiveSourceRank,hlsLevelSupported,liveSourceOptions,selectedTVHlsLevel} from '../canais/resolucoes.js';

const WINDOW_MS=30000,COUNTDOWN_MS=5000;
const positive=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):0;
const capability=(current,id)=>current.sourceCapabilities instanceof Map?current.sourceCapabilities.get(String(id)):current.sourceCapabilities?.[String(id)];
const levelKey=level=>[positive(level?.height),positive(level?.bitrate),level?.videoCodec||''].join(':');
const levelLabel=level=>positive(level?.height)?`${level.height}p`:positive(level?.bitrate)?`${Math.round(level.bitrate/1000)} kb/s`:'nível seguinte';

/** Automatic reductions never change the channel ID. Only this manifest or
 * descriptors authorized for the current channel may supply a lower quality. */
export function nextTVQualityTarget(current){
  if(current?.item?.kind!=='live')return null;
  const hls=current.hls,levels=hls?.levels||[];
  if(levels.length>1){
    const index=current.appAutoSelection||Number.isInteger(current.appAutoLevel)?selectedTVHlsLevel(current):hls.currentLevel;
    const playing=levels[index];
    if(!playing)return null;
    const height=positive(playing.height),bitrate=positive(playing.bitrate);
    const lower=levels.map((level,index)=>({level,index})).filter(({level})=>hlsLevelSupported(level)!==false&&(
      positive(level.height)<height&&positive(level.height)>0
      ||positive(level.height)===height&&bitrate>0&&positive(level.bitrate)>0&&positive(level.bitrate)<bitrate))
      .sort((a,b)=>positive(b.level.height)-positive(a.level.height)||positive(b.level.bitrate)-positive(a.level.bitrate))[0];
    if(lower)return {kind:'level',index:lower.index,key:'level:'+levelKey(lower.level),label:levelLabel(lower.level)};
    return null;
  }
  const manifestHeight=levels.length===1?positive(levels[0]?.height):0;
  const sources=liveSourceOptions(current.sources),selected=sources.find(source=>source.id===current.sourceId),sourceRank=declaredLiveSourceRank(selected);
  const rank=manifestHeight&&sourceRank?Math.min(manifestHeight,sourceRank):sourceRank;
  if(rank&&typeof current.onSourceChange==='function'){
    const source=sources.find(source=>source.available!==false&&source.id!==current.sourceId
      &&capability(current,source.id)!==false&&declaredLiveSourceRank(source)>0&&declaredLiveSourceRank(source)<rank
      &&(!(channelCodec(source)&&channelCodec(source)!==channelCodec(selected))||capability(current,source.id)===true));
    if(source)return {kind:'source',source,key:'source:'+source.id,label:source.quality||`${declaredLiveSourceRank(source)}p`};
  }
  return null;
}

/** Four deduplicated waiting episodes in 30s open one cancellable notice.
 * The application's existing metrics tick advances it; this owns no timers,
 * decoder, provider request, history or VOD policy. */
export class TVAdaptiveQuality{
  constructor({getContext=()=>null,onStep=()=>{},stage,document=stage?.ownerDocument||globalThis.document,now=Date.now,onNotice=()=>{}}={}){
    Object.assign(this,{getContext,onStep,document,now,onNotice});this.owner=null;this.stalls=[];this.pending=null;this.lastAt=null;
    if(stage&&document?.createElement){
      this.notice=document.createElement('div');this.notice.className='tv-quality-notice';this.notice.hidden=true;
      this.notice.setAttribute('role','status');this.notice.setAttribute('aria-live','polite');
      this.copy=document.createElement('span');this.button=document.createElement('button');this.button.type='button';
      this.button.addEventListener('click',event=>{event.stopPropagation();this.cancel();});
      this.notice.append(this.copy,this.button);stage.append(this.notice);
    }
  }
  context(){
    const context=this.getContext(),current=context?.current,video=context?.video;
    if(!context?.enabled||context.navigationPending||current?.item?.kind!=='live'||!current.started||current.failed||current.sourceFallbackBlocked
      ||current.sourceSwitchPending||current.rateLimitedUntil>this.now()||video?.paused||video?.ended||video?.seeking||this.document?.hidden)return null;
    return context;
  }
  render(seconds=null){
    const minimum=this.pending?.target===null,visible=Boolean(this.pending);
    const message=!visible?'':minimum?'Esta fonte não oferece uma qualidade menor.'
      :`A transmissão travou 4 vezes. Reduzindo para ${this.pending.target.label} em ${seconds}s…`;
    if(this.notice){this.notice.hidden=!visible;this.copy.textContent=message;this.button.textContent=minimum?'Entendi':'Manter qualidade';}
    this.onNotice({visible,seconds:visible&&!minimum?seconds:null,message,target:this.pending?.target||null});
  }
  cancel(){this.stalls=[];this.pending=null;this.lastAt=null;this.render();}
  reset(){this.cancel();this.owner=null;}
  recordStall(){
    const context=this.context();if(!context){this.cancel();return;}
    if(this.owner!==context.current){this.reset();this.owner=context.current;}
    const now=this.now();if(this.lastAt!==null&&now<this.lastAt)this.cancel();this.lastAt=now;
    if(this.pending)return;
    this.stalls=this.stalls.filter(at=>now-at<=WINDOW_MS);this.stalls.push(now);
    if(this.stalls.length<4)return;
    const target=nextTVQualityTarget(context.current);this.stalls=[];
    this.pending={owner:context.current,target,deadline:now+COUNTDOWN_MS};this.render(5);
  }
  update(){
    if(!this.pending)return;
    const context=this.context(),now=this.now();
    if(!context||context.current!==this.pending.owner||this.lastAt!==null&&now<this.lastAt){this.cancel();return;}
    this.lastAt=now;
    const target=nextTVQualityTarget(context.current);
    if(this.pending.target&&target?.key!==this.pending.target.key){this.cancel();return;}
    const seconds=Math.max(0,Math.ceil((this.pending.deadline-now)/1000));
    if(seconds){this.render(seconds);return;}
    const selected=this.pending.target?target:null;this.cancel();
    if(selected)this.onStep(selected,context.current);
  }
  dispose(){this.reset();this.notice?.remove();}
}
