import { createAdaptiveState, decideAdaptiveSource } from './adaptive-quality.js';

export const BUFFER_MODES = {
  balanced: {label:'Equilibrada',description:'Equilíbrio entre estabilidade e atraso.',maxBufferLength:30,maxMaxBufferLength:60,liveSyncDurationCount:4,lowLatencyMode:false},
  stable: {label:'Mais estável',description:'Mantém mais vídeo disponível adiante.',maxBufferLength:60,maxMaxBufferLength:120,liveSyncDurationCount:6,lowLatencyMode:false},
  low: {label:'Baixa latência',description:'Prioriza menor distância da transmissão ao vivo.',maxBufferLength:15,maxMaxBufferLength:30,liveSyncDurationCount:3,lowLatencyMode:true}
};
export function fastLoadPolicies(){
  const retry=()=>({maxNumRetry:1,retryDelayMs:500,maxRetryDelayMs:1000});
  return {
    manifestLoadPolicy:{default:{maxTimeToFirstByteMs:4000,maxLoadTimeMs:8000,timeoutRetry:{maxNumRetry:0,retryDelayMs:0,maxRetryDelayMs:0},errorRetry:{maxNumRetry:0,retryDelayMs:0,maxRetryDelayMs:0}}},
    playlistLoadPolicy:{default:{maxTimeToFirstByteMs:4000,maxLoadTimeMs:8000,timeoutRetry:retry(),errorRetry:retry()}},
    fragLoadPolicy:{default:{maxTimeToFirstByteMs:6000,maxLoadTimeMs:15000,timeoutRetry:retry(),errorRetry:retry()}},
    startFragPrefetch:true,initialLiveManifestSize:1
  };
}
export function bufferConfig(mode='balanced') {
  const selected=BUFFER_MODES[mode] || BUFFER_MODES.balanced;
  return {...fastLoadPolicies(),maxBufferLength:selected.maxBufferLength,maxMaxBufferLength:selected.maxMaxBufferLength,liveSyncDurationCount:selected.liveSyncDurationCount,lowLatencyMode:selected.lowLatencyMode,maxBufferSize:48*1024*1024};
}
export function channelFamily(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/(?:\s*[-|([]?\s*(?:sd|hd|fhd|uhd|4k|hevc|h[ .-]?26[45])\s*[)\]]?)+\s*$/i,'')
    .replace(/[^a-z0-9]+/g,' ').trim();
}
export function findChannelVariants(item,items=[]) {
  if(item?.kind!=='live')return [];
  const family=channelFamily(item.name);if(!family)return [];
  const seen=new Set();
  return items.filter(candidate=>candidate.kind==='live'&&channelFamily(candidate.name)===family&&!seen.has(String(candidate.id))&&seen.add(String(candidate.id))).slice(0,10);
}
export function bufferedAhead(video) {
  const time=Number(video.currentTime) || 0;
  for(let index=0;index<video.buffered.length;index++){
    if(video.buffered.start(index)<=time+.15&&video.buffered.end(index)>=time)return Math.max(0,video.buffered.end(index)-time);
  }
  return 0;
}
export function subtitleToVtt(input,extension='srt') {
  const text=String(input).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
  if(!text)throw new Error('O arquivo de legenda está vazio.');
  if(extension.toLowerCase()==='vtt'){
    if(!/^WEBVTT(?:\s|$)/.test(text)||!text.includes('-->'))throw new Error('Este arquivo não contém uma legenda WebVTT válida.');
    return `${text}\n`;
  }
  if(extension.toLowerCase()!=='srt')throw new Error('Escolha uma legenda .srt ou .vtt.');
  const cues=text.replace(/(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{3})/g,(_,hours,minutes,seconds,milliseconds)=>`${hours.padStart(2,'0')}:${minutes}:${seconds}.${milliseconds}`)
    .replace(/[ \t]+(?:X1|X2|Y1|Y2):[^\n]*/g,'');
  if(!/\d{2,3}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2,3}:\d{2}:\d{2}\.\d{3}/.test(cues))throw new Error('Não encontramos os tempos dos diálogos nesta legenda.');
  return `WEBVTT\n\n${cues}\n`;
}
function element(tag,className='',text){const result=document.createElement(tag);result.className=className;if(text!==undefined)result.textContent=text;return result;}
function number(value,digits=1){return Number.isFinite(Number(value))?Number(value).toLocaleString('pt-BR',{maximumFractionDigits:digits,minimumFractionDigits:digits}):'—';}
function available(value){return value!==null&&value!==undefined&&Number.isFinite(Number(value));}
function mbps(value){return available(value)?`${number(value)} Mb/s`:'Sem amostra';}
function ms(value){return available(value)?`${number(value,0)} ms`:'—';}
function trackName(track,index){return track.name || track.label || track.lang || track.language || `Faixa ${index+1}`;}
function tracks(list){try{return Array.from(list || []);}catch{return [];}}

export class PlayerTools {
  constructor(options){
    this.options=options;this.video=options.video;this.current=null;this.listeners=[];this.localTracks=[];this.timers=new Set();this.interval=null;this.diagnosticRequest=0;
    try{this.bufferMode=localStorage.getItem('arkehn.buffer.v1') || 'balanced';}catch{this.bufferMode='balanced';}
    if(!BUFFER_MODES[this.bufferMode])this.bufferMode='balanced';
    try{this.autoQuality=localStorage.getItem('arkehn.autoQuality.v1')!=='false';}catch{this.autoQuality=true;}
    this.adaptiveState=null;
    try{const saved=JSON.parse(localStorage.getItem('arkehn.playbackProfiles.v1') || '{}');this.profiles={live:BUFFER_MODES[saved.live]?saved.live:this.bufferMode,vod:['balanced','stable'].includes(saved.vod)?saved.vod:'balanced'};}catch{this.profiles={live:this.bufferMode,vod:'balanced'};}
    this.$=selector=>document.querySelector(selector);
    for(const id of ['connection-test-header','connection-test-account','connection-test-player','diagnostics-repeat'])this.$(`#${id}`).addEventListener('click',()=>this.diagnostics());
    this.$('#subtitle-file').addEventListener('change',event=>this.addSubtitle(event.target));
    this.$('#diagnostics-dialog').addEventListener('close',()=>{this.diagnosticRequest++;});
    for(const detail of this.$('#player-dialog').querySelectorAll('.player-control'))detail.addEventListener('toggle',()=>{if(detail.open)for(const other of this.$('#player-dialog').querySelectorAll('.player-control'))if(other!==detail)other.open=false;});
    this.renderMenus();
  }
  listen(target,event,listener){target?.addEventListener?.(event,listener);this.listeners.push(()=>target?.removeEventListener?.(event,listener));}
  listenHls(event,listener){const hls=this.current?.hls;if(event&&hls){hls.on(event,listener);this.listeners.push(()=>hls.off(event,listener));}}
  reset(){
    if(this.interval)clearInterval(this.interval);this.interval=null;
    for(const timer of this.timers)clearTimeout(timer);this.timers.clear();
    this.listeners.forEach(remove=>remove());this.listeners=[];
    for(const local of this.localTracks){local.element.remove();URL.revokeObjectURL(local.url);}this.localTracks=[];
    this.current=null;this.subtitleSelection=null;this.$('#subtitle-file').value='';
    for(const id of ['metric-resolution','metric-buffer','metric-bandwidth'])this.$('#'+id).textContent='—';this.$('#metric-stalls').textContent='0';this.$('#metric-latency').textContent='Não disponível';this.$('#metric-error-row').hidden=true;this.$('#playback-health').textContent='Preparando reprodução';this.$('#playback-overview').textContent='Dados disponíveis ao iniciar';this.$('#player-telemetry').dataset.health='pending';
    for(const detail of this.$('#player-dialog').querySelectorAll('.player-control'))detail.open=false;
  }
  attach({item,hls=null,variants=[],automatic=false,adaptiveState=null,errorEvents=[]}){
    this.reset();this.bufferMode=this.profiles[item.kind==='live'?'live':'vod'];this.current={item,hls,variants,started:false,buffering:false,stalls:0,lastStall:0,segments:0,networkRetries:0,mediaRetries:0,failed:false,measuredBitrateBps:null,forcedLevel:null,intentionalSeekUntil:0,errorEvents:[...errorEvents].slice(-6)};
    this.adaptiveState=automatic&&adaptiveState?adaptiveState:createAdaptiveState({now:Date.now(),currentId:item.id});
    const current=this.current;
    this.listen(this.video,'playing',()=>{if(this.current!==current)return;current.started=true;current.buffering=false;this.updateMetrics();});
    const waiting=()=>{if(this.current!==current||this.video.paused||!current.started||current.buffering||Date.now()<current.intentionalSeekUntil)return;current.buffering=true;current.stalls++;current.lastStall=Date.now();this.updateMetrics();};
    this.listen(this.video,'waiting',waiting);
    for(const event of ['loadedmetadata','resize','durationchange'])this.listen(this.video,event,()=>{this.renderMenus();this.updateMetrics();});
    this.listen(this.video,'pause',()=>this.updateMetrics());
    for(const list of [this.video.textTracks,this.video.audioTracks])for(const event of ['addtrack','removetrack','change'])this.listen(list,event,()=>this.renderMenus());
    if(hls){
      const events=window.Hls.Events;
      for(const event of ['MANIFEST_PARSED','LEVELS_UPDATED','LEVEL_SWITCHED','AUDIO_TRACKS_UPDATED','AUDIO_TRACK_SWITCHED','SUBTITLE_TRACKS_UPDATED','SUBTITLE_TRACK_SWITCH'])this.listenHls(events[event],()=>{this.applyAutoQuality();this.renderMenus();});
      this.listenHls(events.FRAG_LOADED,(_,data)=>{if(this.current===current){current.segments++;const bytes=data.payload?.byteLength || data.stats?.loaded || data.frag?.stats?.total,duration=data.frag?.duration;if(Number(bytes)>0&&Number(duration)>0){const measured=bytes*8/duration;current.measuredBitrateBps=current.measuredBitrateBps?current.measuredBitrateBps*.7+measured*.3:measured;}this.updateMetrics();}});
    }
    this.interval=setInterval(()=>this.updateMetrics(),1000);this.applyAutoQuality();this.renderMenus();this.updateMetrics();
  }
  choice(menu,label,selected,action,detail,disabled=false){
    const option=element('button',`control-option${selected?' selected':''}`);option.type='button';option.disabled=disabled;option.setAttribute('aria-pressed',String(selected));
    option.append(element('span','',label));if(detail)option.append(element('small','',detail));
    option.addEventListener('click',()=>{action?.();option.closest('details').open=false;});menu.append(option);return option;
  }
  note(menu,text){menu.append(element('p','control-note',text));}
  renderMenus(){this.renderQuality();this.renderSubtitles();this.renderAudio();this.renderBuffer();}
  renderQuality(){
    const menu=this.$('#quality-menu');menu.replaceChildren();const current=this.current,hls=current?.hls,levels=hls?.levels || [];
    const measured=this.video.videoHeight>0?`${this.video.videoHeight}p`:'';
    if(levels.length>1){
      const auto=hls.autoLevelEnabled;this.$('#quality-label').textContent=auto?`Automática${measured?' · '+measured:''}`:(measured || 'Selecionada');
      this.choice(menu,'Automática',auto,()=>{this.setAutoQuality(true);this.renderQuality();},'Ajuste entre as fontes oferecidas.');
      levels.map((level,index)=>({level,index})).sort((a,b)=>(b.level.height||0)-(a.level.height||0)).forEach(({level,index})=>{
        const label=level.height?`${level.height}p`:level.name || `Fonte ${index+1}`;
        this.choice(menu,label,!auto&&hls.currentLevel===index,()=>{this.setAutoQuality(false,index);this.$('#quality-label').textContent=label;},level.bitrate?`${number(level.bitrate/1e6)} Mb/s`:'');
      });
    }else{
      this.$('#quality-label').textContent=`${this.autoQuality&&current?.variants.length>1?'Automática':'Original'}${measured?' · '+measured:''}`;
      this.choice(menu,`Original${measured?' · '+measured:''}`,true,null,'Resolução fornecida pela fonte atual.',true);
    }
    if(current?.variants.length>1){
      menu.append(element('span','control-group-label','FONTES DESTE CANAL'));
      for(const variant of current.variants)this.choice(menu,variant.name,String(variant.id)===String(current.item.id),()=>this.options.switchChannel(variant,{automatic:false}));
      this.note(menu,'HD, FHD e SD são identificações informadas pelo serviço.');
    }else if(current)this.note(menu,levels.length>1?'As opções pertencem à transmissão atual.':'Esta fonte não oferece outras resoluções selecionáveis.');
  }
  disableSubtitles(){
    if(this.current?.hls){this.current.hls.subtitleTrack=-1;this.current.hls.subtitleDisplay=false;}
    for(const track of tracks(this.video.textTracks))if(['subtitles','captions'].includes(track.kind))track.mode='disabled';
  }
  renderSubtitles(){
    const menu=this.$('#subtitle-menu');menu.replaceChildren();const hls=this.current?.hls,provided=hls?.subtitleTracks || [];
    const native=tracks(this.video.textTracks).filter(track=>['subtitles','captions'].includes(track.kind));
    const active=provided.some((_,index)=>hls.subtitleDisplay&&hls.subtitleTrack===index)||native.some(track=>track.mode==='showing');
    this.choice(menu,'Desativadas',!active,()=>{this.subtitleSelection=null;this.disableSubtitles();this.renderSubtitles();});
    let selectedName='Desativadas';
    provided.forEach((track,index)=>{const selected=hls.subtitleDisplay&&hls.subtitleTrack===index,label=trackName(track,index);if(selected)selectedName=label;this.choice(menu,label,selected,()=>{this.disableSubtitles();hls.subtitleTrack=index;hls.subtitleDisplay=true;this.subtitleSelection={type:'hls',index};this.$('#subtitle-label').textContent=label;});});
    native.forEach((track,index)=>{
      const local=this.localTracks.find(entry=>entry.element.track===track);
      if(!local&&provided.some(providedTrack=>(providedTrack.name || providedTrack.lang)===(track.label || track.language)))return;
      const selected=track.mode==='showing',label=local?local.name:trackName(track,index);if(selected)selectedName=label;
      this.choice(menu,label,selected,()=>{this.disableSubtitles();track.mode='showing';this.subtitleSelection={type:'native',track};this.$('#subtitle-label').textContent=label;});
    });
    if(!provided.length&&!native.length)this.note(menu,'A fonte não disponibilizou legendas. Você pode adicionar um arquivo.');
    this.$('#subtitle-label').textContent=selectedName;
  }
  async addSubtitle(input){
    const file=input.files?.[0],current=this.current;input.value='';if(!file)return;
    if(!current){this.options.toast('Escolha um vídeo antes de adicionar legendas.');return;}
    try{
      if(file.size>2*1024*1024)throw new Error('Use um arquivo de legenda de até 2 MB.');
      const extension=file.name.split('.').pop().toLowerCase(),vtt=subtitleToVtt(await file.text(),extension);if(this.current!==current)return;
      const url=URL.createObjectURL(new Blob([vtt],{type:'text/vtt'})),track=element('track');track.kind='subtitles';track.label=file.name;track.srclang='pt-BR';track.src=url;
      this.localTracks.push({element:track,url,name:file.name});
      track.addEventListener('load',()=>{if(this.current!==current)return;this.disableSubtitles();track.track.mode='showing';this.subtitleSelection={type:'native',track:track.track};this.renderSubtitles();this.options.toast('Legenda adicionada');},{once:true});
      track.addEventListener('error',()=>{if(this.current===current)this.options.toast('Não foi possível ler esta legenda. Confira o arquivo.');},{once:true});
      this.video.append(track);track.track.mode='hidden';this.renderSubtitles();
    }catch(error){this.options.toast(error.message);}
  }
  renderAudio(){
    const menu=this.$('#audio-menu');menu.replaceChildren();const hls=this.current?.hls,provided=hls?.audioTracks || [],native=tracks(this.video.audioTracks);let label='Original';
    if(provided.length){provided.forEach((track,index)=>{const selected=hls.audioTrack===index,name=trackName(track,index);if(selected)label=name;this.choice(menu,name,selected,()=>{hls.audioTrack=index;this.$('#audio-label').textContent=name;});});}
    else if(native.length){native.forEach((track,index)=>{const selected=track.enabled,name=trackName(track,index);if(selected)label=name;this.choice(menu,name,selected,()=>{native.forEach(candidate=>candidate.enabled=candidate===track);this.$('#audio-label').textContent=name;});});}
    else{this.choice(menu,'Áudio original',true,null,null,true);this.note(menu,'O navegador não expôs outras faixas desta fonte.');}
    this.$('#audio-label').textContent=label;
  }
  renderBuffer(){
    const menu=this.$('#buffer-menu');menu.replaceChildren();const hls=this.current?.hls;
    this.$('#buffer-label').textContent=hls?BUFFER_MODES[this.bufferMode].label:'Automática';
    const profile=this.current?.item.kind==='live'?'live':'vod';
    for(const [key,mode] of Object.entries(BUFFER_MODES)){if(profile==='vod'&&key==='low')continue;this.choice(menu,profile==='live'&&key==='low'?'Esportes · menos atraso':mode.label,key===this.bufferMode,()=>{
      this.setProfile(profile,key);this.renderBuffer();
    },mode.description,!hls);}
    this.note(menu,hls?'Ao mudar o perfil, o vídeo pode avançar ou voltar alguns segundos. O atraso também depende da origem.':'Nesta fonte, o navegador gerencia o carregamento automaticamente.');
  }
  applyAutoQuality(){
    const current=this.current,hls=current?.hls;if(!hls||hls.levels.length<2)return;
    if(this.autoQuality){hls.nextLevel=-1;current.forcedLevel=null;return;}
    if(current.forcedLevel===null&&hls.currentLevel>=0)current.forcedLevel=hls.currentLevel;
    if(current.forcedLevel!==null)hls.nextLevel=current.forcedLevel;
  }
  setAutoQuality(enabled,level=null){
    this.autoQuality=Boolean(enabled);try{localStorage.setItem('arkehn.autoQuality.v1',String(this.autoQuality));}catch{}
    if(this.current){this.current.forcedLevel=level;this.adaptiveState=createAdaptiveState({now:Date.now(),currentId:this.current.item.id});this.adaptiveState.lastStallCount=this.current.stalls;this.applyAutoQuality();this.renderQuality();}
  }
  syncToProfile(){
    const current=this.current,position=current?.hls?.liveSyncPosition;
    if(current?.item.kind!=='live'||!Number.isFinite(position)||position<=0||this.video.readyState<1)return false;
    if(Math.abs(this.video.currentTime-position)>1){current.intentionalSeekUntil=Date.now()+4000;this.video.currentTime=position;this.options.toast('Perfil aplicado. A posição ao vivo foi ajustada.');}
    return true;
  }
  configFor(kind){return {...bufferConfig(this.profiles[kind==='live'?'live':'vod']),backBufferLength:kind==='live'?30:60};}
  setProfile(profile,key){
    if(!BUFFER_MODES[key]||(profile==='vod'&&key==='low'))return;
    this.profiles[profile]=key;try{localStorage.setItem('arkehn.playbackProfiles.v1',JSON.stringify(this.profiles));}catch{}
    if(this.current&&profile===(this.current.item.kind==='live'?'live':'vod')){this.bufferMode=key;if(this.current.hls){Object.assign(this.current.hls.config,bufferConfig(key));if(profile==='live')this.syncToProfile();}this.renderBuffer();}
  }
  renderPreferences(container){
    container.replaceChildren();const auto=element('label','settings-auto-quality');const check=element('input');check.type='checkbox';check.checked=this.autoQuality;const copy=element('span');copy.append(element('strong','','Ajustar qualidade automaticamente'),element('small','','Usa as resoluções e fontes disponíveis, com base na reprodução e na conexão medida.'));check.addEventListener('change',()=>{this.setAutoQuality(check.checked);});auto.append(check,copy);container.append(auto);container.append(element('p','settings-description','Escolha um perfil para TV ao vivo e outro para filmes e séries. Cada fonte mantém sua qualidade original.'));
    for(const [profile,title] of [['live','TV ao vivo'],['vod','Filmes e séries']]){
      const section=element('section','settings-profile');section.append(element('h3','',title));const choices=element('div','settings-presets');
      for(const [key,mode] of Object.entries(BUFFER_MODES)){
        if(profile==='vod'&&key==='low')continue;const choice=element('button',`settings-preset${this.profiles[profile]===key?' selected':''}`);choice.type='button';choice.setAttribute('aria-pressed',String(this.profiles[profile]===key));
        choice.append(element('strong','',profile==='live'&&key==='low'?'Esportes · menos atraso':mode.label),element('span','',mode.description));
        choice.addEventListener('click',()=>{this.setProfile(profile,key);this.renderPreferences(container);});choices.append(choice);
      }
      section.append(choices);container.append(section);
    }
    container.append(element('p','settings-notice','Um perfil com menos atraso pode precisar aguardar dados com mais frequência. Ao aplicar um perfil ao vivo, a posição do vídeo pode avançar ou voltar alguns segundos. A origem e o navegador determinam o atraso possível; nas fontes nativas, o navegador gerencia o buffer. Se uma fonte não oferecer variantes, sua qualidade original é preservada.'));
  }
  diagnose(){return this.diagnostics();}
  updateMetrics(){
    const current=this.current;if(!current)return;const buffer=bufferedAhead(this.video),resolution=this.video.videoWidth&&this.video.videoHeight?`${this.video.videoWidth} × ${this.video.videoHeight}`:'Aguardando vídeo';
    const bandwidth=current.hls&&current.segments>0&&Number.isFinite(current.hls.bandwidthEstimate)?current.hls.bandwidthEstimate/1e6:null;
    this.$('#metric-resolution').textContent=resolution;this.$('#metric-buffer').textContent=`${number(buffer)} s`;this.$('#metric-stalls').textContent=String(current.stalls);this.$('#metric-bandwidth').textContent=bandwidth===null?'Não disponível':`≈ ${number(bandwidth)} Mb/s`;
    const lastError=current.errorEvents.at(-1);this.$('#metric-error-row').hidden=!lastError;this.$('#metric-last-error').textContent=lastError?.detail || '—';
    const live=current.item.kind==='live',latency=current.hls?.latency;this.$('#metric-latency-row').hidden=!live;this.$('#telemetry-latency-note').hidden=!live;this.$('.telemetry-values').classList.toggle('has-live-latency',live);this.$('#metric-latency').textContent=Number.isFinite(latency)&&latency>0?`≈ ${number(latency)} s`:'Não disponível';
    let health='Preparando reprodução',state='pending';
    if(current.failed){health='Reprodução interrompida';state='poor';}
    else if(this.video.ended){health='Reprodução concluída';state='good';}
    else if(current.started&&this.video.paused){health='Pausado';state='pending';}
    else if(current.started){
      if(current.buffering&&buffer<.5){health='Aguardando dados';state='poor';}
      else if(buffer<2||(current.lastStall&&Date.now()-current.lastStall<15000)){health='Recuperando estabilidade';state='fair';}
      else{health='Reprodução estável';state='good';}
    }
    this.$('#playback-health').textContent=health;this.$('#player-telemetry').dataset.health=state;
    this.$('#playback-overview').textContent=`${this.video.videoHeight?this.video.videoHeight+'p · ':''}${number(buffer)} s de vídeo disponível`;
    if(current.started&&!current.failed&&!this.video.paused&&!this.video.ended&&current.item.kind==='live'&&(current.hls?.levels.length || 0)<=1){
      const level=current.hls?.levels[current.hls.currentLevel],bitrate=Number(level?.bitrate)>0?Number(level.bitrate):current.measuredBitrateBps;
      const decision=decideAdaptiveSource({state:this.adaptiveState,now:Date.now(),enabled:this.autoQuality,bufferSeconds:buffer,stalls:current.stalls,bandwidthBps:bandwidth===null?null:bandwidth*1e6,currentBitrateBps:bitrate,variants:current.variants,currentItem:current.item});
      this.adaptiveState=decision.state;
      if(decision.target){this.options.toast(decision.reason==='repeated-stalls'?'Fonte ajustada para recuperar a estabilidade.':'Fonte ajustada após medir folga na conexão.');this.options.switchChannel(decision.target,{automatic:true,adaptiveState:decision.state,reason:decision.reason});}
    }

  }
  recordError(data){
    if(!this.current)return;
    const allowed=Object.values(window.Hls?.ErrorDetails || {}),detail=allowed.includes(data.details)?data.details:'unknownError';
    const type=['networkError','mediaError','muxError','keySystemError','otherError'].includes(data.type)?data.type:'otherError';
    this.current.errorEvents.push({type,detail,at:new Date().toISOString()});this.current.errorEvents=this.current.errorEvents.slice(-6);this.updateMetrics();
  }
  getErrorEvents(){return [...(this.current?.errorEvents || [])];}
  fail(){if(this.current){this.current.failed=true;this.updateMetrics();}}
  recoverError(data){
    const current=this.current;if(!current?.hls||!data.fatal)return false;const hls=current.hls;
    if(data.type==='networkError'&&current.started&&current.networkRetries<2){
      current.networkRetries++;this.$('#player-status').textContent=`Restabelecendo a transmissão… (${current.networkRetries}/2)`;
      const timer=setTimeout(()=>{this.timers.delete(timer);if(this.current===current&&!current.failed)hls.startLoad();},current.networkRetries*900);this.timers.add(timer);return true;
    }
    if(data.type==='mediaError'&&current.mediaRetries<1){current.mediaRetries++;this.$('#player-status').textContent='Recuperando a reprodução…';hls.recoverMediaError();return true;}
    return false;
  }
  async diagnostics(){
    const dialog=this.$('#diagnostics-dialog');if(!dialog.open)dialog.showModal();const request=++this.diagnosticRequest,generation=this.options.connectionGeneration();const content=this.$('#diagnostics-content');content.replaceChildren();
    const loading=element('div','detail-loading');loading.append(element('span','spinner'),element('span','','Verificando a conexão com o serviço…'));content.append(loading);this.$('#diagnostics-repeat').disabled=true;this.$('#diagnostics-checked').textContent='';
    try{
      const data=await this.options.api('/api/diagnostics');if(request!==this.diagnosticRequest||generation!==this.options.connectionGeneration()||!dialog.open)return;this.renderDiagnostics(data);
    }catch(error){if(request!==this.diagnosticRequest||generation!==this.options.connectionGeneration())return;content.replaceChildren(element('p','diagnostics-error',error.message));}
    finally{if(request===this.diagnosticRequest)this.$('#diagnostics-repeat').disabled=false;}
  }
  renderDiagnostics(data){
    const content=this.$('#diagnostics-content');content.replaceChildren();const assessment=data.assessment || {},server=data.server || {},playback=data.playback || {};
    const status=element('section','diagnostics-assessment');status.dataset.status=assessment.status || 'insufficient';status.append(element('span','assessment-dot'),element('h3','',assessment.title || 'Conexão verificada'),element('p','',assessment.detail || 'Confira as medições abaixo.'));content.append(status);
    const grid=element('div','diagnostics-grid');
    const rate=available(server.successRate)?`${number(Number(server.successRate)<=1?Number(server.successRate)*100:server.successRate,0)}%`:'—';
    const values=[['Serviço',server.host || 'Servidor configurado'],['Resposta',server.reachable?'Disponível':'Sem resposta'],['Tempo de resposta',ms(server.latencyMs)],['Variação da resposta',ms(server.jitterMs)],['Respostas concluídas',rate],['Entrega do vídeo',mbps(playback.throughputMbps)],['Necessidade da fonte',mbps(playback.requiredMbps)],['Amostras de vídeo',String(playback.segmentSamples ?? 0)]];
    for(const [label,value] of values){const metric=element('div','diagnostics-metric');metric.append(element('span','',label),element('strong','',value));grid.append(metric);}content.append(grid);
    if(this.current?.failed)content.append(element('p','diagnostics-error','A reprodução está interrompida neste navegador. A entrega medida pelo servidor e a compatibilidade do vídeo são verificações diferentes.'));
    if(playback.active)content.append(element('p','diagnostics-context','As medições de vídeo usam a sessão que já está em reprodução.'));
    else content.append(element('p','diagnostics-context','Inicie um vídeo para incluir medições reais de entrega na próxima verificação.'));
    if((data.recommendations || []).length){const section=element('section','diagnostics-recommendations');section.append(element('h3','','Para a sua sessão'));const list=element('ul');for(const tip of data.recommendations)list.append(element('li','',tip));section.append(list);content.append(section);}
    if(this.current?.errorEvents.length){const events=element('details','diagnostics-limits');events.append(element('summary','','Eventos da reprodução'));const list=element('ul');for(const event of this.current.errorEvents){const date=new Date(event.at);list.append(element('li','',`${date.toLocaleTimeString('pt-BR')} · ${event.detail}`));}events.append(list);content.append(events);}
    if((data.limits || []).length){const detail=element('details','diagnostics-limits');detail.append(element('summary','','Como interpretar este teste'));const list=element('ul');for(const limit of data.limits)list.append(element('li','',limit));detail.append(list);content.append(detail);}
    if(data.checkedAt){const date=new Date(data.checkedAt);if(Number.isFinite(date.getTime()))this.$('#diagnostics-checked').textContent=`Verificado às ${date.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;}
  }
}
