import {playerEnginePreference} from './preferencias.js';
import {SHAKA_DISTRIBUTION} from './distribuicao.js';
import {createShakaHlsClass} from './shaka/index.js';
import {supportsNativeHLS} from '../../live-playback-session.js';

let loading=null,ShakaClass=null;
const cancelled=()=>new DOMException('A abertura foi cancelada.','AbortError');
const unavailable=()=>Object.assign(new Error('O Shaka não está disponível neste navegador. Selecione Atual em Configurações → Player.'),{code:'PLAYER_ENGINE_UNAVAILABLE'});

function loadShaka(){
  if(loading)return loading;
  loading=new Promise((resolve,reject)=>{
    let settled=false;
    const script=document.createElement('script');
    script.src=SHAKA_DISTRIBUTION.src;script.integrity=SHAKA_DISTRIBUTION.integrity;
    script.crossOrigin='anonymous';script.async=true;
    const finish=error=>{
      if(settled)return;settled=true;
      clearTimeout(timer);script.onload=script.onerror=null;
      if(error){script.remove();reject(error);return;}
      const library=globalThis.shaka;
      if(!library?.Player||String(library.Player.version).replace(/^v/,'')!==SHAKA_DISTRIBUTION.version){script.remove();reject(unavailable());return;}
      resolve(library);
    };
    const timer=setTimeout(()=>finish(unavailable()),20000);
    script.onload=()=>finish();script.onerror=()=>finish(unavailable());
    document.head.append(script);
  }).catch(error=>{loading=null;throw error;});
  return loading;
}

/** Select only at an opening boundary. Loading this library never opens media. */
export function resolvePlayerTransport({engine=playerEnginePreference.get(),video,signal}={}){
  if(signal?.aborted)throw cancelled();
  if(engine!=='shaka')return {HlsClass:globalThis.Hls,usingNativeHLS:supportsNativeHLS(video),engine:'current'};
  if(ShakaClass){
    if(!ShakaClass.isSupported())throw unavailable();
    return {HlsClass:ShakaClass,usingNativeHLS:false,engine:'shaka'};
  }
  return loadShaka().then(library=>{
    if(signal?.aborted)throw cancelled();
    if(!ShakaClass){library.polyfill.installAll();ShakaClass=createShakaHlsClass({shaka:library,HlsClass:globalThis.Hls});}
    if(!ShakaClass.isSupported())throw unavailable();
    return {HlsClass:ShakaClass,usingNativeHLS:false,engine:'shaka'};
  });
}

export {playerEnginePreference};
