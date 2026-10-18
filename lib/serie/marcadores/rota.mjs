import {currentPlaybackIntent,playbackReader} from '../../live-playback-session.mjs';
import {markerRequest} from '../../../web/serie/marcadores/referencia.js';
import {EpisodeMarkersOnDemand} from './sob-demanda.mjs';

export class EpisodeMarkerRoute{
  constructor({respond,service=new EpisodeMarkersOnDemand()}={}){Object.assign(this,{respond,service});}
  async handle(req,res,url,{state,client}){
    if(url.pathname!=='/api/series/episode-markers')return false;
    const reply=(value,status=200)=>this.respond(res,value,status);
    if(req.method!=='GET'){reply({error:'Método inválido.'},405);return true;}
    const get=key=>url.searchParams.get(key),episodeId=get('episodeId');
    const input=markerRequest({imdbId:get('imdbId'),season:Number(get('season')),episode:Number(get('episode')),duration:Number(get('duration'))});
    if(!input||!/^\d{1,12}$/.test(episodeId||'')||!['season','episode','duration'].every(key=>get(key)!==null)){reply({error:'Episódio inválido.'},400);return true;}
    const intent=currentPlaybackIntent(state,client,{kind:'series',id:episodeId,active:true});
    if(!intent){reply({error:'Este episódio não está em reprodução.',code:'MARKER_PLAYBACK_REQUIRED'},409);return true;}
    state.parental.assertPlayback('series',episodeId);
    const reader=playbackReader(req,res);
    const signal=AbortSignal.any([reader.signal,client.playback.controller.signal]);
    try{
      const result=await this.service.lookup(input,{signal});
      if(reader.signal.aborted)return true;
      if(currentPlaybackIntent(state,client,{kind:'series',id:episodeId,active:true})!==intent){reply({error:'Esta reprodução foi encerrada.'},409);return true;}
      state.parental.assertPlayback('series',episodeId);reply(result);
    }catch(error){
      if(reader.signal.aborted)return true;
      if(signal.aborted){reply({error:'Esta reprodução foi encerrada.'},409);return true;}throw error;
    }finally{reader.dispose();}
    return true;
  }
}
