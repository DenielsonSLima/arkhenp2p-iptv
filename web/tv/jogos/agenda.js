import {artworkURL} from '../../channel-artwork.js';

const CACHE_MS = 60000;
const text = value => typeof value==='string' || typeof value==='number' ? String(value).trim() : '';
const validID = value => /^\d{1,12}$/.test(String(value ?? ''));
const defaultZone = () => {try {return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';} catch {return 'UTC';}};
const serverUpdateMessage = 'A agenda precisa da atualização do servidor local. Reinicie o servidor para ativar.';
const sessionRequiredMessage = 'Sua sessão expirou. Entre novamente para consultar a agenda.';

export function gamesDate(now, timeZone = 'UTC') {
  const parts=new Intl.DateTimeFormat('en',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));return `${values.year}-${values.month}-${values.day}`;
}

export function gameChannels(game, channels = []) {
  const visible=new Map();
  for (const entry of Array.isArray(channels)?channels:[]) {
    const item=entry?.item || entry;if(item?.kind==='live' && validID(item.id))visible.set(String(item.id),item);
  }
  const seen=new Set();
  return (Array.isArray(game?.channels)?game.channels:[]).map(channel=>visible.get(String(channel?.id ?? channel)))
    .filter(item=>{if(!item || seen.has(String(item.id)))return false;seen.add(String(item.id));return true;});
}

export function gameDisplay(game, {timeZone = 'UTC'} = {}) {
  const home=text(game?.homeTeam?.name),away=text(game?.awayTeam?.name),status=text(game?.status);
  const statusKey=status.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[ _-]+/g,' ');
  const live=['live','ao vivo','in progress','playing','em andamento'].includes(statusKey);
  const labels={scheduled:'Agendado',finished:'Encerrado',ended:'Encerrado',postponed:'Adiado',cancelled:'Cancelado',canceled:'Cancelado'};
  let kickoff='Horário não informado';
  if (typeof game?.start==='string' && game.start.includes('T') && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(game.start)) {
    const instant=Date.parse(game.start);
    if(Number.isFinite(instant))kickoff=new Intl.DateTimeFormat('pt-BR',{timeZone,hour:'2-digit',minute:'2-digit'}).format(instant);
  }
  return {title:text(game?.title) || [home,away].filter(Boolean).join(' × ') || 'Partida não identificada',home,away,
    league:text(game?.league?.name) || 'Competição não informada',kickoff,score:text(game?.score),live,
    status:live?'Ao vivo':labels[statusKey] || (/^\d+$/.test(status)?'':status)};
}

/** Cached, cancellable feed for the live catalog's games category. */
export class DailyGames {
  constructor({request,getNamespace = () => '',getChannels = () => [],supportsGames = () => true,onWatch = () => {},timeZone = defaultZone(),now = Date.now,
    document = globalThis.document,schedule = (callback,delay) => globalThis.setTimeout(callback,delay),cancel = timer => globalThis.clearTimeout(timer),onUpdate = () => {}}) {
    Object.assign(this,{request,getNamespace,getChannels,supportsGames,onWatch,timeZone,now,document,schedule,cancel,onUpdate});
    // Validate the display zone without guessing a replacement offset.
    try {gamesDate(now(),timeZone);} catch {this.timeZone='UTC';}
    this.namespace=String(getNamespace());this.epoch=0;this.cache=new Map();this.pending=null;this.timer=null;this.active=false;
    this.state={status:'idle',data:null,error:''};this.section=null;this.dataKey='';this.cardsSignature='';this.blockedReason='';
  }
  getSection() {
    if (this.section) return this.section;
    const section=this.#node('section','daily-games');section.setAttribute('aria-label','Jogos de hoje');
    const heading=this.#node('div','daily-games-heading');heading.append(this.#node('h2','','Jogos de hoje'));
    this.dateNode=this.#node('span','daily-games-date');heading.append(this.dateNode);
    this.message=this.#node('p','daily-games-message');this.message.setAttribute('role','status');
    this.retry=this.#node('button','daily-games-retry','Tentar novamente');this.retry.type='button';this.retry.addEventListener('click',()=>{void this.refresh();});
    this.list=this.#node('div','daily-games-list');section.append(heading,this.message,this.retry,this.list);this.section=section;this.#render();return section;
  }
  mount(container,{before = null} = {}) {
    const section=this.getSection();
    if(section.parentElement!==container || section.nextElementSibling!==before)container.insertBefore(section,before);
    void this.start();return section;
  }
  start() {this.#ensureNamespace();this.active=true;this.#render();return this.#load(false);}
  stop() {this.active=false;this.#cancelTimer();this.#cancelRequest();}
  reset() {
    this.active=false;this.epoch++;this.#cancelTimer();this.#cancelRequest();this.cache.clear();this.namespace=String(this.getNamespace());
    this.dataKey='';this.blockedReason='';this.state={status:'idle',data:null,error:''};this.#publish();
  }
  refresh() {this.#ensureNamespace();this.active=true;return this.#load(true);}
  #node(tag,className = '',value) {const node=this.document.createElement(tag);node.className=className;if(value!==undefined)node.textContent=value;return node;}
  #ensureNamespace() {if(String(this.getNamespace())!==this.namespace)this.reset();}
  #cancelTimer() {if(this.timer!==null)this.cancel(this.timer);this.timer=null;}
  #cancelRequest() {if(this.pending){this.pending.controller.abort();this.cancel(this.pending.deadline);this.pending=null;}}
  #current(job) {return this.active && this.pending===job && this.epoch===job.epoch && String(this.getNamespace())===job.namespace;}
  #publish() {this.#render();this.onUpdate(this.state);}
  #unavailable(reason,message) {
    this.#cancelTimer();this.#cancelRequest();
    const changed=this.state.status!=='unavailable' || this.state.reason!==reason;
    this.state={status:'unavailable',reason,data:null,error:message};
    if(changed)this.#publish();
    return Promise.resolve(null);
  }
  #schedule(delay) {
    this.#cancelTimer();if(!this.active)return;
    this.timer=this.schedule(()=>{this.timer=null;if(this.active)void this.start();},Math.max(1000,delay));
  }
  #load(force) {
    if(!this.supportsGames() || this.blockedReason==='server-update-required')return this.#unavailable('server-update-required',serverUpdateMessage);
    if(this.blockedReason==='session-required')return this.#unavailable('session-required',sessionRequiredMessage);
    const date=gamesDate(this.now(),this.timeZone),key=`${this.namespace}:${date}:${this.timeZone}`;
    if(this.pending?.key===key)return this.pending.promise;
    if(this.pending)this.#cancelRequest();
    if(this.dataKey!==key){this.dataKey=key;this.state={status:'idle',data:null,error:''};}
    const cached=this.cache.get(key);
    if(!force && cached && cached.expiresAt>this.now()) {
      const unchanged=this.state.status==='ready' && this.state.data===cached.data && !this.state.error;
      this.state={status:'ready',data:cached.data,error:''};if(!unchanged)this.#publish();this.#schedule(cached.expiresAt-this.now());return Promise.resolve(cached.data);
    }
    this.#cancelTimer();
    const job={key,date,namespace:this.namespace,epoch:this.epoch,controller:new AbortController(),deadline:null,promise:null};
    this.pending=job;this.state={status:'loading',data:this.state.data,error:''};this.#publish();
    job.deadline=this.schedule(()=>job.controller.abort(),10000);
    job.promise=Promise.resolve().then(async()=>{
      try {
        if(!this.#current(job) || job.controller.signal.aborted)return null;
        const response=await this.request(`/api/games?date=${date}&timezone=${encodeURIComponent(this.timeZone)}&lang=pt`,{signal:job.controller.signal});
        if(!this.#current(job) || job.controller.signal.aborted)return null;
        if(typeof response?.available!=='boolean' || !Array.isArray(response.games) || response.date!==date)throw new Error('Invalid schedule');
        const data={available:response.available,date,timeZone:this.timeZone,games:response.available?response.games:[]};
        this.cache.set(key,{data,expiresAt:this.now()+CACHE_MS});while(this.cache.size>3)this.cache.delete(this.cache.keys().next().value);
        this.state={status:'ready',data,error:''};return data;
      } catch (error) {
        if(this.#current(job)) {
          if(error?.status===404 || error?.status===401) {
            this.blockedReason=error.status===404?'server-update-required':'session-required';
            this.state={status:'unavailable',reason:this.blockedReason,data:null,error:error.status===404?serverUpdateMessage:sessionRequiredMessage};
          } else {
            const providerFailure=error?.status===502 && ['WPLAY_GAMES_UNAVAILABLE','WPLAY_INVALID_GAMES'].includes(error?.code);
            this.state={status:'error',data:this.state.data,error:providerFailure?'O serviço de jogos está indisponível agora. Tente novamente.':'Não foi possível consultar a agenda agora.'};
          }
        }
        return null;
      } finally {
        this.cancel(job.deadline);
        if(this.#current(job)) {
          this.pending=null;this.#publish();
          if(this.state.status!=='unavailable')this.#schedule(this.state.status==='error'?30000:CACHE_MS);
        }
      }
    });
    return job.promise;
  }
  #logo(value,className='daily-game-team-logo') {
    const source=artworkURL(value);if(!source)return null;
    const logo=this.#node('img',className);logo.src=source;logo.alt='';logo.loading='lazy';logo.decoding='async';
    logo.width=logo.height=className==='daily-game-league-logo'?28:36;
    logo.addEventListener('error',()=>logo.remove());return logo;
  }
  #render() {
    if(!this.section)return;
    const {data,status,error}=this.state,date=data?.date || gamesDate(this.now(),this.timeZone);
    this.section.dataset.state=status;this.section.setAttribute('aria-busy',String(status==='loading'));
    this.dateNode.textContent=new Intl.DateTimeFormat('pt-BR',{timeZone:'UTC',weekday:'long',day:'2-digit',month:'long'}).format(new Date(`${date}T12:00:00Z`));
    const games=data?.available?data.games:[];
    this.message.textContent=error || (data?.available===false?'Agenda não disponibilizada pelo serviço':data&&!games.length?'Nenhum jogo informado para hoje':!data?'Carregando jogos do dia…':'');
    this.message.hidden=!this.message.textContent;this.retry.hidden=status!=='error';
    const channels=this.getChannels(),signature=JSON.stringify([this.namespace,games,games.map(game=>gameChannels(game,channels).map(item=>[String(item.id),text(item.name)]))]);
    if(signature!==this.cardsSignature) {this.cardsSignature=signature;this.list.replaceChildren(...games.map(game=>this.#card(game,channels)));}
  }
  #card(game,visibleChannels) {
    const presentation=gameDisplay(game,{timeZone:this.timeZone}),card=this.#node('article','daily-game');
    card.setAttribute('aria-label',presentation.title);card.dataset.live=String(presentation.live);
    const top=this.#node('div','daily-game-top'),league=this.#node('span','daily-game-league'),time=this.#node('time','daily-game-time',presentation.kickoff);
    const leagueLogo=this.#logo(game.league?.logo,'daily-game-league-logo');if(leagueLogo)league.append(leagueLogo);
    league.append(this.#node('span','daily-game-league-name',presentation.league));
    if(game.start && presentation.kickoff!=='Horário não informado')time.setAttribute('datetime',game.start);top.append(league,time);card.append(top);
    if(presentation.status)card.append(this.#node('span','daily-game-status',presentation.status));
    if(presentation.home && presentation.away) {
      const teams=this.#node('div','daily-game-teams');
      for(const team of [game.homeTeam,game.awayTeam]) {const row=this.#node('div','daily-game-team'),logo=this.#logo(team.logo);if(logo)row.append(logo);row.append(this.#node('strong','',text(team.name)));teams.append(row);}
      card.append(teams);
    } else card.append(this.#node('h3','daily-game-title',presentation.title));
    if(presentation.score)card.append(this.#node('strong','daily-game-score',presentation.score));
    const actions=this.#node('div','daily-game-actions'),channels=gameChannels(game,visibleChannels),namespace=this.namespace;
    for(const channel of channels) {
      const watch=this.#node('button','daily-game-watch',`Assistir · ${text(channel.name)}`);watch.type='button';
      watch.addEventListener('click',()=>{
        if(namespace!==String(this.getNamespace()))return;
        const current=gameChannels(game,this.getChannels()).find(item=>String(item.id)===String(channel.id));
        if(current)this.onWatch(current);else this.#render();
      });actions.append(watch);
    }
    if(!channels.length)actions.append(this.#node('span','daily-game-unmapped','Canal não informado'));
    card.append(actions);return card;
  }
}
