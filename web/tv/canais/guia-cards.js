import {programWindow} from './programacao.js';
import {sharedTVGuide} from '../tanstack-query.js';

function element(tag,className='',value){
  const node=document.createElement(tag);node.className=className;if(value!==undefined)node.textContent=value;return node;
}

/** Cards register their channel IDs in one shared server projection. No
 * per-card provider request, clock or programme selection is involved. */
export class ChannelGuide{
  constructor({api,connectionGeneration,guide=null}){
    Object.assign(this,{api,connectionGeneration});this.generation=this.readGeneration();
    this.guide=guide||sharedTVGuide({request:api,getScope:()=>({account:this.readGeneration()})});
    this.paused=false;this.records=new Map();this.unsubscribe=null;this.interval=null;
  }
  readGeneration(){return String(typeof this.connectionGeneration==='function'?this.connectionGeneration():0);}
  ensureGeneration(){if(this.readGeneration()!==this.generation)this.reset();}
  peek(id){this.ensureGeneration();return this.guide?.peek(id)||null;}
  connect(){
    if(this.paused||this.unsubscribe||!this.records.size||!this.guide)return;
    this.unsubscribe=this.guide.subscribe(state=>{this.ensureGeneration();this.prune();for(const record of this.records.values())this.render(record,this.guide.peek(record.id),state);},{ids:()=>[...this.records.values()].map(record=>record.id)});
    if(this.interval===null)this.interval=setInterval(()=>this.prune(),30_000);
  }
  observe(card,item){
    if(!card||item?.kind!=='live'||!/^\d{1,12}$/.test(String(item.id)))return;
    this.ensureGeneration();this.prune();const existing=this.records.get(card);
    if(existing?.id===String(item.id))return;if(existing)this.remove(existing);
    const root=element('div','channel-guide'),placeholder=element('span','channel-guide-placeholder','Carregando programação…');
    const rows=element('div','channel-guide-rows'),nodes={};
    for(const [key,label] of [['current','Agora'],['next','Próximo']]){
      const row=element('div',`channel-guide-row channel-guide-${key}`),title=element('strong','channel-guide-title'),time=element('span','channel-guide-time');
      row.append(element('span','channel-guide-label',label),title,time);rows.append(row);nodes[key]={title,time};
    }
    const progress=element('progress','channel-guide-progress');progress.max=100;progress.value=0;progress.setAttribute('aria-label','Tempo do programa atual');
    root.append(placeholder,rows,progress);(card.querySelector('.channel-copy')||card).append(root);
    const record={card,id:String(item.id),root,placeholder,rows,nodes,progress,connectedOnce:card.isConnected,createdAt:Date.now()};
    this.records.set(card,record);this.render(record,this.guide?.peek(record.id),this.guide?.state);this.unsubscribe?.updateIds?.();this.connect();
  }
  render(record,data,state={}){
    const programs=programWindow(data),available=Boolean(programs.current||programs.next),loading=!data&&Boolean(state?.loading),failed=!data&&Boolean(state?.error);
    record.root.dataset.state=available?'ready':loading?'loading':failed?'error':'unavailable';
    record.root.dataset.stale=String(Boolean(data?.stale||state?.stale));
    record.placeholder.hidden=available;record.placeholder.textContent=loading?'Carregando programação…':failed?'Não foi possível carregar a programação.':'Programação não informada';record.rows.hidden=!available;
    for(const key of ['current','next']){
      const program=programs[key],nodes=record.nodes[key];nodes.title.textContent=program?.title||'Não informada';nodes.title.title=program?.title||'';
      nodes.time.textContent=program?key==='current'?[program.startLabel,program.endLabel].filter(Boolean).join(' — '):program.startLabel:'';
    }
    record.progress.hidden=!programs.current;record.progress.value=programs.current?data.progressPercent:0;
  }
  remove(record){this.records.delete(record.card);record.root.remove();}
  prune(){
    const size=this.records.size,now=Date.now();for(const record of this.records.values()){
      if(record.card.isConnected)record.connectedOnce=true;
      else if(record.connectedOnce||now-record.createdAt>1000)this.remove(record);
    }
    if(!this.records.size){this.unsubscribe?.();this.unsubscribe=null;clearInterval(this.interval);this.interval=null;}
    else if(size!==this.records.size)this.unsubscribe?.updateIds?.();
  }
  tick(){this.ensureGeneration();this.prune();if(!this.paused&&this.records.size){this.connect();void this.guide?.ensure();}}
  pause(){this.paused=true;this.unsubscribe?.();this.unsubscribe=null;clearInterval(this.interval);this.interval=null;}
  resume(){this.ensureGeneration();this.paused=false;this.tick();}
  reset(){
    this.generation=this.readGeneration();this.unsubscribe?.();this.unsubscribe=null;
    for(const record of this.records.values())record.root.remove();this.records.clear();clearInterval(this.interval);this.interval=null;
  }
  destroy(){this.pause();this.reset();}
}
