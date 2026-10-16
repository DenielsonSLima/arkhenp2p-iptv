import {TVServices} from './services.js';
import {TVGuideClient} from './tanstack-query.js';
import {TVSupabase} from './supabase.js';
import {TVRealtime} from './realtime.js';
import {TVFavorites} from './canais/favoritos.js';
import {TVChannelList} from './canais/lista.js';
import {ChannelGuide} from './canais/guia-cards.js';
import {LiveProgramFeed} from './canais/feed.js';
import {createLiveView} from './canais/visualizacao.js';
import {DailyGames} from './jogos/agenda.js';
import {TVAudio} from './canais/audio.js';
import {tvScope} from './scope.js';

/** Composition root for live TV. Session, catalogue, media element and Auth
 * belong to the application. TV owns only its readers and their lifecycle. */
export class TVOrchestrator{
  constructor({request,getScope=()=>null}={}){
    this.request=request;this.getScope=()=>tvScope(getScope());
    this.services=new TVServices({request,getScope:this.getScope});
    this.guide=new TVGuideClient({services:this.services,getScope:this.getScope});
  }
  configure({cloudLibrary,getSession,repository,loadCatalog,getCatalog,isVisible,isCategoryAllowed,getNumber,
    getLocalFavorites,onLocalChange,getVisibleChannels,volumeMemory,audioProcessing}={}){
    if(this.supabase)throw new Error('TV_ALREADY_CONFIGURED');
    this.supabase=new TVSupabase({cloudLibrary,getSession});
    this.favorites=new TVFavorites({supabase:this.supabase,getScope:this.getScope,getLocalFavorites,onLocalChange,
      isVisible,getQueryClient:()=>this.guide.client});
    this.channels=new TVChannelList({repository,loadCatalog,getCatalog,getScope:this.getScope,isVisible,
      isCategoryAllowed,getNumber,getFavorites:getLocalFavorites});
    this.realtime=new TVRealtime({guide:this.guide,favorites:this.favorites,channels:this.channels,getScope:this.getScope});
    this.audio=new TVAudio({volumeMemory,audioProcessing});this.getVisibleChannels=getVisibleChannels;
    return this;
  }
  createView(options){this.view=createLiveView(options);return this.view;}
  createCard(item){return this.view.createCard(item);}
  mountCard(card,item){return this.view.mountCard(card,item);}
  createCardGuide(options){if(this.cards)throw new Error('TV_CARD_GUIDE_EXISTS');return this.cards=new ChannelGuide({...options,api:this.services.api,guide:this.guide});}
  createProgramFeed(options){if(this.program)throw new Error('TV_PROGRAM_FEED_EXISTS');return this.program=new LiveProgramFeed({...options,request:this.services.api,guide:this.guide});}
  createGames(options){if(this.games)throw new Error('TV_GAMES_EXISTS');return this.games=new DailyGames({...options,request:this.services.api});}
  visibleChannels(){return this.getVisibleChannels?.()||this.channels?.numbered()||[];}
  async preparePlayback(item,{signal,sourceId=''}={}){
    if(item?.kind!=='live')throw new TypeError('TV_CHANNEL_REQUIRED');
    const available=await this.services.liveSources(item.id,{signal});
    return {sources:available.sources,sourceId:sourceId||available.selectedSourceId||''};
  }
  playbackURL(item,{attempt='',sourceId='',purpose='playback'}={}){
    if(item?.kind!=='live'||!/^\d{1,12}$/.test(String(item.id)))throw new TypeError('TV_CHANNEL_REQUIRED');
    const params=new URLSearchParams();if(attempt)params.set('attempt',attempt);if(sourceId)params.set('sourceId',sourceId);if(purpose==='preview')params.set('purpose','preview');
    return `/api/play/live/${encodeURIComponent(item.id)}/index.m3u8${params.size?'?'+params:''}`;
  }
  startProgram(id,options){this.program?.start(id,options);}
  stopProgram(){this.program?.stop();}
  onSharedUpdate(event){return this.realtime?.sharedUpdated(event)||false;}
  onLibraryChange(snapshot,changes){return this.realtime?.libraryUpdated(snapshot,changes)||false;}
  reset(){
    this.stopProgram();this.cards?.reset();this.games?.stop();this.services.reset();this.guide.reset();
    this.realtime?.reset();this.channels?.reset();this.favorites?.reset();this.supabase?.reset();
  }
  dispose(){
    this.reset();this.cards?.destroy();this.program?.destroy();this.games?.stop();this.guide.dispose();
    this.services.dispose();this.realtime?.dispose();this.channels?.dispose();this.favorites?.dispose();this.supabase?.dispose();
  }
}
