import {node,iconNode} from '../sistema/ui/dom.js';
import {reconcileChildren} from '../catalog-renderer.js';
import {HALF_HOUR,timelinePrograms,timelineRange,timelineSlot,timelinePosition,timelineFormatter} from './linha-tempo.js';

const itemKey=item=>`live:${String(item.id)}`;
const timeLabel=program=>[program.startLabel,program.endLabel].filter(Boolean).join(' — ');
const monotonic=()=>performance.now();

/** One shared server projection supplies the schedule and programme states.
 * The visual clock advances from serverTime using elapsed monotonic time;
 * it never selects programmes, changes progress or requests a channel. */
export class FavoriteTVGuide{
  constructor({guide,getChannelNumber=()=>null,onPlay,createLogo,makeFavorite,updateFavoriteButton,
    getScope=()=>'',isActive=()=>true}={}){
    Object.assign(this,{guide,getChannelNumber,onPlay,createLogo,makeFavorite,updateFavoriteButton,getScope,isActive});
    this.records=new Map();this.root=null;this.container=null;this.body=null;this.notice=null;
    this.scope=this.readScope();this.paused=true;this.subscription=null;this.clockTimer=null;
    this.clockAnchor=null;this.clockSource=null;this.range=null;this.zone=null;this.zoom='detail';this.selection=null;this.selectedEvent=null;this.resizeObserver=null;
  }
  readScope(){return String(this.getScope?.()??'');}

  createRoot(container){
    const root=node('div','grade-tv'),toolbar=node('div','grade-tv-toolbar'),clockGroup=node('div','grade-tv-clock-group');
    this.clock=node('time','grade-tv-clock','--:--:--');clockGroup.append(node('span','grade-tv-clock-label','Agora'),this.clock);
    const controls=node('div','grade-tv-timeline-controls');this.zoomButtons=new Map();
    for(const [mode,label]of [['detail','Com rolagem'],['fit','Ajustar à tela']]){
      const control=node('button','grade-tv-fit-button',label);control.type='button';control.setAttribute('aria-pressed',String(mode===this.zoom));control.addEventListener('click',()=>this.setZoom(mode));controls.append(control);this.zoomButtons.set(mode,control);
    }
    for(const [direction,label,icon]of [[-1,'Ver horários anteriores','chevron-left'],[1,'Ver próximos horários','chevron-right']]){
      const control=node('button','grade-tv-scroll-button');control.type='button';control.setAttribute('aria-label',label);control.title=label;control.append(iconNode(icon));
      control.addEventListener('click',()=>this.scrollTimeline(direction));controls.append(control);
    }
    const now=node('button','grade-tv-now-button','Ir para agora');now.type='button';now.addEventListener('click',()=>this.scrollToNow());controls.append(now);toolbar.append(clockGroup,controls);
    this.detail=node('div','grade-tv-program-detail');this.detail.id='favorite-tv-program-detail';this.detail.hidden=true;this.detailMeta=node('span','grade-tv-detail-meta');this.detailTitle=node('strong','grade-tv-detail-title');this.detail.append(this.detailMeta,this.detailTitle);
    const table=node('table','grade-tv-table'),head=node('thead'),heading=node('tr');
    table.append(node('caption','grade-tv-caption','Programação dos canais favoritos por horário'));
    for(const [className,label]of [['number','Nº'],['channel','Canal'],['timeline-heading','Programação'],['actions','Favorito']]){
      const cell=node('th',`grade-tv-heading grade-tv-${className}`,label);cell.scope='col';
      if(className==='timeline-heading'){
        cell.textContent='';cell.setAttribute('aria-label','Horários da programação');this.ruler=node('div','grade-tv-ruler');
        this.rulerTicks=node('div','grade-tv-ruler-ticks');this.rulerNow=node('span','grade-tv-now-label');this.rulerNow.hidden=true;
        this.rulerLine=this.nowLine();this.ruler.append(this.rulerTicks,this.rulerLine,this.rulerNow);cell.append(this.ruler);
      }
      heading.append(cell);
    }
    head.append(heading);this.body=node('tbody','grade-tv-body');table.append(head,this.body);
    this.scroller=node('div','grade-tv-scroll');this.scroller.tabIndex=0;this.scroller.setAttribute('role','region');
    this.scroller.setAttribute('aria-label','Grade de programação. Role na horizontal para ver outros horários. Role a página para ver mais canais.');this.scroller.append(table);
    this.notice=node('p','grade-tv-notice');this.notice.hidden=true;this.notice.setAttribute('role','status');
    root.dataset.zoom=this.zoom;root.append(toolbar,this.detail,this.scroller,this.notice);container.append(root);this.root=root;this.container=container;this.scroller.scrollLeft=0;
    if(typeof ResizeObserver==='function')this.resizeObserver=new ResizeObserver(()=>{if(this.isActive())this.renderRuler();});
    queueMicrotask(()=>{if(this.root===root&&this.isActive()){this.scroller.scrollLeft=0;this.renderRuler();}});
  }
  nowLine(){const line=node('span','grade-tv-now-line');line.hidden=true;line.setAttribute('aria-hidden','true');return line;}

  createRecord(item){
    const row=node('tr','grade-tv-row'),number=node('td','grade-tv-number'),channel=node('td','grade-tv-channel');
    const record={item,row,number,channel,logo:null,logoSignature:null,events:new Map()};row.dataset.itemKey=itemKey(item);
    const watch=node('button','grade-tv-channel-button');watch.type='button';watch.addEventListener('click',()=>this.onPlay?.(record.item));
    const showCurrent=()=>{if(record.currentProgram)this.selectProgram(record,record.currentProgram);};watch.addEventListener('pointerenter',showCurrent);watch.addEventListener('focus',showCurrent);
    const copy=node('span','grade-tv-channel-copy'),name=node('strong','grade-tv-channel-name'),group=node('span','grade-tv-channel-group');copy.append(name,group);watch.append(copy);channel.append(watch);
    const timeline=node('td','grade-tv-timeline-cell'),track=node('div','grade-tv-track'),eventsHost=node('div','grade-tv-events');
    const empty=node('span','grade-tv-timeline-empty'),line=this.nowLine();track.append(eventsHost,empty,line);timeline.append(track);
    const favoriteItem={...item},actions=node('td','grade-tv-actions'),favorite=this.makeFavorite?.(favoriteItem);
    if(favorite){favorite.dataset.guideAction='favorite';actions.append(favorite);}row.append(number,channel,timeline,actions);
    return Object.assign(record,{watch,copy,name,group,favorite,favoriteItem,track,eventsHost,empty,line});
  }
  updateRecord(record,item){
    record.item=item;for(const key of Object.keys(record.favoriteItem))if(!Object.hasOwn(item,key))delete record.favoriteItem[key];Object.assign(record.favoriteItem,item);
    const number=this.getChannelNumber(item),assigned=Number(number);record.number.textContent=number!=null&&Number.isInteger(assigned)&&assigned>0?String(assigned):'—';
    record.number.setAttribute('aria-label',record.number.textContent==='—'?'Canal sem número':`Canal ${assigned}`);
    record.name.textContent=item.name||'Canal';record.name.title=item.name||'';record.group.textContent=item.group||'';record.group.hidden=!item.group;
    record.watch.setAttribute('aria-label',`Assistir ${item.name||'ao canal'}`);
    const signature=JSON.stringify([item.name,item.poster,item.posterOriginal]);
    if(record.logoSignature!==signature){record.logo?.remove();record.logo=this.createLogo?.(item)||node('span','grade-tv-logo-fallback',String(item.name||'TV').slice(0,2));record.logo.classList.add('grade-tv-logo');record.watch.prepend(record.logo);record.logoSignature=signature;}
    if(record.favorite)this.updateFavoriteButton?.(record.favorite,item);
  }

  render(container,items=[]){
    if(!container)return;if(this.readScope()!==this.scope)this.reset();
    if(this.container!==container){this.reset();this.createRoot(container);}else if(this.root.parentElement!==container)container.append(this.root);
    const active=document.activeElement,focusedRow=active?.closest?.('.grade-tv-row');
    const focus=focusedRow&&this.body.contains(focusedRow)?{element:active,index:[...this.body.children].indexOf(focusedRow)}:null;
    const wanted=new Set(),rows=[];
    for(const item of items){
      if(item?.kind!=='live'||item.id==null)continue;const key=itemKey(item);if(wanted.has(key))continue;wanted.add(key);
      let record=this.records.get(key);if(!record){record=this.createRecord(item);this.records.set(key,record);}this.updateRecord(record,item);rows.push(record.row);
    }
    for(const key of this.records.keys())if(!wanted.has(key))this.records.delete(key);reconcileChildren(this.body,rows);
    if(focus&&document.activeElement!==focus.element)(focus.element.isConnected?focus.element:rows[Math.min(focus.index,rows.length-1)]?.querySelector('.grade-tv-channel-button'))?.focus({preventScroll:true});
    this.renderPrograms(this.guide?.state);if(this.isActive())this.resume();else this.pause();
  }

  synchronizeClock(data){
    const stamp=Date.parse(data?.serverTime);
    if(!Number.isFinite(stamp))return;
    if(this.clockSource!==data){this.clockAnchor={stamp,monotonic:monotonic()};this.clockSource=data;}
    const zone=data.timeZone||'America/Maceio';
    if(this.zone!==zone){this.zone=zone;this.format=timelineFormatter(zone);this.clockFormat=timelineFormatter(zone,{seconds:true});}
  }
  serverNow(){return this.clockAnchor?this.clockAnchor.stamp+Math.max(0,monotonic()-this.clockAnchor.monotonic):NaN;}
  updateRange(data,channels){
    const range=timelineRange(Date.parse(data?.serverTime),channels);if(!range)return;
    if(this.range?.start===range.start&&this.range?.end===range.end)return;
    this.range=range;this.root.style.setProperty('--grade-tv-hours',String(range.hours));this.renderRuler();
  }

  renderRuler(){
    if(!this.range||!this.rulerTicks)return;
    const width=this.body.firstElementChild?.querySelector('.grade-tv-track')?.clientWidth||440,capacity=Math.max(2,Math.floor(width/65));
    const step=[HALF_HOUR,2*HALF_HOUR,4*HALF_HOUR,6*HALF_HOUR,12*HALF_HOUR,24*HALF_HOUR].find(value=>this.range.duration/value<=capacity)||24*HALF_HOUR;
    const version=`${this.range.start}:${this.range.end}:${step}:${this.zone}`;if(this.rulerTicks.dataset.version===version)return;
    const first=Math.ceil(this.range.start/step)*step;
    this.rulerTicks.dataset.version=version;this.root.style.setProperty('--grade-tv-tick-step',`${step/this.range.duration*100}%`);this.root.style.setProperty('--grade-tv-first-tick',`${timelinePosition(first,this.range)}%`);
    const ticks=[];for(let stamp=first;stamp<this.range.end;stamp+=step){const tick=node('span','grade-tv-tick',this.format.format(stamp));tick.style.left=`${timelinePosition(stamp,this.range)}%`;ticks.push(tick);}this.rulerTicks.replaceChildren(...ticks);
  }

  setZoom(mode){
    if(!this.root||!['fit','detail'].includes(mode))return;this.zoom=mode;this.root.dataset.zoom=mode;
    for(const [value,control]of this.zoomButtons)control.setAttribute('aria-pressed',String(value===mode));
    this.scroller.scrollLeft=0;this.renderRuler();
  }

  selectProgram(record,program){
    this.selection={channelKey:itemKey(record.item),programKey:program.key};
    this.selectedEvent?.classList.remove('is-selected');this.selectedEvent=record.events.get(program.key)?.element;this.selectedEvent?.classList.add('is-selected');
    this.detailMeta.textContent=[record.item.name,program.label,timeLabel(program)].filter(Boolean).join(' · ');this.detailTitle.textContent=program.title;this.detail.hidden=false;
  }

  synchronizeSelection(channels){
    let selected=null,fallback=null;
    for(const {record,programs}of channels)for(const program of programs){
      if(!timelineSlot(program,this.range))continue;
      if(!fallback||fallback.program.name!=='current'&&program.name==='current')fallback={record,program};
      if(this.selection?.channelKey===itemKey(record.item)&&this.selection.programKey===program.key)selected={record,program};
    }
    const next=selected||fallback;if(next)this.selectProgram(next.record,next.program);else{this.selection=null;this.selectedEvent=null;this.detail.hidden=true;this.detailMeta.textContent='';this.detailTitle.textContent='';}
  }

  renderEvents(record,programs,state){
    const events=[],wanted=new Set(),focused=document.activeElement,ownedFocus=record.track.contains(focused);
    for(const program of programs){
      const slot=this.range&&timelineSlot(program,this.range);if(!slot)continue;
      const current=program.name==='current',key=program.key;wanted.add(key);
      let event=record.events.get(key);
      if(!event){
        const element=node('button','grade-tv-event');element.type='button';
        const status=node('span','grade-tv-event-status'),time=node('span','grade-tv-event-time'),title=node('strong','grade-tv-event-title');element.append(status,time,title);event={element,status,time,title,program};
        const select=()=>this.selectProgram(record,event.program);element.addEventListener('click',select);element.addEventListener('pointerenter',select);element.addEventListener('focus',select);record.events.set(key,event);
      }
      event.program=program;const {element}=event;element.className=`grade-tv-event ${current?'is-current':program.name==='next'?'is-next':'is-later'}${slot.compact?' is-compact':''}`;
      element.style.left=`${slot.left}%`;element.style.width=`max(1px, calc(${slot.width}% - 2px))`;
      event.status.textContent=program.label;event.time.textContent=timeLabel(program);event.title.textContent=program.title;
      element.title=[program.label,timeLabel(program),program.title,program.description].filter(Boolean).join('\n');
      element.setAttribute('aria-label',`Ver programação · ${record.item.name} · ${program.label} · ${timeLabel(program)} · ${program.title}`);element.setAttribute('aria-describedby','favorite-tv-program-detail');events.push(element);
    }
    for(const key of record.events.keys())if(!wanted.has(key))record.events.delete(key);reconcileChildren(record.eventsHost,events);
    if(ownedFocus&&document.activeElement!==focused)(focused.isConnected?focused:record.watch).focus({preventScroll:true});
    record.empty.hidden=events.length>0;record.empty.textContent=state?.loading?'Carregando programação…':state?.error?'Programação indisponível no momento.':'Programação não informada';
  }

  renderPrograms(state={}){
    if(this.readScope()!==this.scope){this.reset();return;}if(!this.root)return;
    this.synchronizeClock(state?.data);
    const channels=[];for(const record of this.records.values()){
      const data=this.guide?.peek(String(record.item.id));if(this.readScope()!==this.scope||!this.records.has(itemKey(record.item)))return;channels.push({record,data});
    }
    this.updateRange(state?.data,channels.map(({data})=>data));let stale=Boolean(state?.stale),available=false;
    for(const channel of channels){
      const {record,data}=channel,programs=timelinePrograms(data);channel.programs=programs;stale||=Boolean(data?.stale);available||=programs.length>0;
      const current=programs.find(program=>program.name==='current');record.currentProgram=current||null;record.group.textContent=current?.title||record.item.group||'';record.group.title=current?[timeLabel(current),current.title].filter(Boolean).join(' · '):record.item.group||'';record.group.hidden=!record.group.textContent;
      record.row.dataset.state=programs.length?'ready':state?.loading?'loading':state?.error?'error':'unavailable';record.row.dataset.stale=String(Boolean(data?.stale||state?.stale));this.renderEvents(record,programs,state);
    }
    this.notice.hidden=!(available&&(stale||state?.error));this.notice.textContent=state?.error?'Não foi possível atualizar. Exibindo a última programação disponível.':'Exibindo a última programação disponível.';
    if(this.range)this.synchronizeSelection(channels);this.updateClock();
  }

  updateClock(){
    const stamp=this.serverNow(),available=Number.isFinite(stamp)&&Boolean(this.range);if(!this.root)return;
    this.clock.textContent=available?this.clockFormat.format(stamp):'--:--:--';
    if(available)this.clock.dateTime=new Date(stamp).toISOString();else this.clock.removeAttribute('datetime');
    const position=available?timelinePosition(stamp,this.range):NaN,visible=Number.isFinite(position)&&position>=0&&position<=100;
    for(const line of [this.rulerLine,...[...this.records.values()].map(record=>record.line)]){line.hidden=!visible;if(visible)line.style.left=`${position}%`;}
    this.rulerNow.hidden=!visible;if(visible){this.rulerNow.style.left=`${position}%`;this.rulerNow.textContent=this.format.format(stamp);}
  }
  startClock(){
    if(this.clockTimer!==null||this.paused)return;
    this.clockTimer=setTimeout(()=>{this.clockTimer=null;if(!this.isActive()||this.paused){this.pause();return;}this.updateClock();this.startClock();},1000);
  }
  scrollToNow(){
    if(!this.range||!this.scroller?.isConnected)return;const track=this.body.firstElementChild?.querySelector('.grade-tv-track');if(!track)return;
    const record=this.records.values().next().value,fixed=(record?.number.offsetWidth||0)+(record?.channel.offsetWidth||0),available=Math.max(0,this.scroller.clientWidth-fixed);
    this.scroller.scrollLeft=Math.max(0,(this.serverNow()-this.range.start)/this.range.duration*track.clientWidth-Math.min(60,available*.2));
  }
  scrollTimeline(direction){if(this.scroller)this.scroller.scrollLeft+=direction*Math.max(180,this.scroller.clientWidth*.65);}

  resume(){
    if(!this.isActive()){this.pause();return;}if(this.readScope()!==this.scope){this.reset();return;}this.paused=false;this.resizeObserver?.observe(this.scroller);
    if(this.subscription||!this.records.size||!this.guide?.subscribe){this.startClock();return;}
    const subscription={unsubscribe:null};this.subscription=subscription;
    const unsubscribe=this.guide.subscribe(state=>{if(this.subscription!==subscription||this.paused)return;if(!this.isActive()){this.pause();return;}this.renderPrograms(state);});
    if(this.subscription===subscription&&!this.paused){subscription.unsubscribe=unsubscribe;this.startClock();}else unsubscribe?.();
  }
  pause(){this.paused=true;clearTimeout(this.clockTimer);this.clockTimer=null;this.resizeObserver?.disconnect();const subscription=this.subscription;this.subscription=null;subscription?.unsubscribe?.();}
  reset(){this.pause();this.root?.remove();this.records.clear();this.root=null;this.container=null;this.body=null;this.notice=null;this.scope=this.readScope();this.clockAnchor=null;this.clockSource=null;this.range=null;this.zone=null;this.zoom='detail';this.selection=null;this.selectedEvent=null;this.resizeObserver=null;}
  destroy(){this.reset();}
}
