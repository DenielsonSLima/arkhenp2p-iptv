import {measuredQualityLabel} from '../channel-variants.js';

const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:0;
export function seriesLevelSupported(level){
  const mediaSource=globalThis.MediaSource||globalThis.ManagedMediaSource,codec=level?.videoCodec;
  if(!codec||typeof mediaSource?.isTypeSupported!=='function')return null;
  try{return mediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`);}catch{return null;}
}

/** Series quality is the selected episode's actual manifest or measured file,
 * never a different episode/title with a matching quality suffix. */
export function renderSeriesQuality(tools){
  const current=tools.current;if(current?.item.kind!=='series')return false;
  const menu=tools.$('#quality-menu');menu.replaceChildren();
  const hls=current.hls,levels=hls?.levels||[],measured=measuredQualityLabel(tools.video.videoHeight,tools.video.videoWidth);
  const automatic=tools.autoQuality&&current.qualityMode!=='manual';
  if(levels.length>1){
    tools.$('#quality-label').textContent=`${automatic?'Automática':'Manual'}${measured?' · '+measured:''}`;
    tools.choice(menu,'Automática',automatic,()=>{if(tools.current===current)tools.setAutoQuality(true);},'Ajusta somente os níveis oferecidos por este episódio.');
    levels.map((level,index)=>({level,index})).sort((a,b)=>positive(b.level.height)-positive(a.level.height)||positive(b.level.bitrate)-positive(a.level.bitrate)).forEach(({level,index})=>{
      const unsupported=seriesLevelSupported(level)===false,label=measuredQualityLabel(level.height,level.width)||level.name||`Nível ${index+1}`;
      const bitrate=positive(level.bitrate),detail=unsupported?'Formato não compatível com este navegador.':`Resolução anunciada${bitrate?' · '+(bitrate/1e6).toLocaleString('pt-BR',{maximumFractionDigits:1})+' Mb/s':''}`;
      tools.choice(menu,label,!automatic&&(current.forcedLevel===index||current.forcedLevel===null&&hls.currentLevel===index),()=>{if(tools.current===current)tools.setAutoQuality(false,index);},detail,unsupported);
    });
  }else{
    tools.$('#quality-label').textContent=`Original${measured?' · '+measured:''}`;
    tools.choice(menu,`Original${measured?' · '+measured:''}`,true,null,'Resolução fornecida pelo arquivo ou pela única variante disponível.',true);
    tools.note(menu,'Este episódio não oferece outras resoluções selecionáveis nesta fonte.');
  }
  if(tools.video.videoWidth>0&&tools.video.videoHeight>0)tools.note(menu,`Em reprodução: ${tools.video.videoWidth} × ${tools.video.videoHeight}.`);
  return true;
}

export function applySeriesQuality(tools){
  const current=tools.current,hls=current?.hls;if(current?.item.kind!=='series'||!hls||hls.levels.length<2)return false;
  const automatic=tools.autoQuality&&current.qualityMode!=='manual';
  if(hls.config)hls.config.preserveManualLevelOnError=!automatic;
  if(automatic){
    if(current.appliedQualityMode!=='auto'||hls.autoLevelEnabled===false)hls.loadLevel=-1;
    current.forcedLevel=null;current.appliedQualityMode='auto';current.appliedManualLevel=null;return true;
  }
  const valid=index=>Number.isInteger(index)&&index>=0&&index<hls.levels.length&&seriesLevelSupported(hls.levels[index])!==false;
  if(!valid(current.forcedLevel)){
    const height=current.qualityMode==='manual'?current.manualHeight:null;
    const offered=positive(height)?hls.levels.findIndex(level=>level.height===height&&seriesLevelSupported(level)!==false):-1;
    current.forcedLevel=offered>=0?offered:valid(hls.currentLevel)?hls.currentLevel:null;
  }
  if(!valid(current.forcedLevel))return false;
  if(current.appliedQualityMode!=='manual'||current.appliedManualLevel!==current.forcedLevel||hls.autoLevelEnabled===true){
    hls.loadLevel=current.forcedLevel;current.appliedQualityMode='manual';current.appliedManualLevel=current.forcedLevel;
  }
  return true;
}

export function seriesQualitySelection(tools){
  const current=tools.current;if(current?.item.kind!=='series')return null;
  const manual=!tools.autoQuality||current.qualityMode==='manual',height=current.hls?.levels[current.forcedLevel]?.height??current.manualHeight;
  return {qualityMode:manual?'manual':'auto',qualityHeight:manual&&Number.isSafeInteger(height)&&height>0?height:null};
}
