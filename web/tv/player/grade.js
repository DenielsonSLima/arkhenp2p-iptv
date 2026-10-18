import {element,icon} from '../../player/dom.js';
import {programWindow} from '../canais/programacao.js';
import {renderPlayerChannelLogo} from '../../player-channel-logos.js';
import {TVPlayerPrograms} from './programacao.js';

const text=value=>String(value??'').trim();
const number=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?String(value).padStart(3,'0'):'';

/** TV-only presentation. Browsing updates this strip, never the playing item. */
export class TVPlayerGuide{
  constructor({navigation,guide,request,getNamespace}={}){
    this.navigation=navigation;this.current=null;this.programs=null;this.rendering=false;
    this.metadata=new TVPlayerPrograms({guide,request,getNamespace,onUpdate:()=>this.render()});
    this.slots={};
    for(const [key,label] of [['previous','Canal anterior'],['current','TV AO VIVO'],['next','Próximo canal']]){
      const center=key==='current',button=element('button',center?'ip-channel-current ip-channel-selection':`ip-channel-neighbor ip-channel-${key}`);
      button.type='button';button.hidden=true;
      const logo=element('span',`ip-channel-logo ip-channel-logo-${center?'current':'neighbor'}`);logo.hidden=true;
      const labelNode=element('span',center?'ip-kind':'ip-neighbor-label',label);
      const numberNode=element('span',center?'ip-channel-number':'ip-neighbor-number');
      const name=element(center?'h2':'span',center?'ip-title':'ip-neighbor-name');
      if(center){
        const heading=element('div','ip-information-heading'),copy=element('div','ip-information-copy');
        copy.append(labelNode,name);heading.append(numberNode,copy);button.append(logo,heading);
      }else{
        const arrow=icon(key==='previous'?'chevron-left':'chevron-right');arrow.classList.add('ip-neighbor-arrow');
        button.append(logo,labelNode,numberNode,name,arrow);
      }
      const schedule=element('div',center?'ip-schedule':'ip-neighbor-schedule'),status=element('span','ip-neighbor-schedule-status');
      schedule.id=`ip-player-schedule-${key}`;schedule.setAttribute('aria-label','Programação do canal');
      button.setAttribute('aria-describedby',schedule.id);
      schedule.append(status);const programs={};
      for(const [period,caption] of [['previous','Anterior'],['current','Agora'],['next','Próximo']]){
        const row=element('div',`ip-program ip-${center?'program':'neighbor-program'}-${period}`),title=element('strong','ip-program-title'),time=element('span','ip-program-time');
        row.append(element('span','ip-program-label',caption),title,time);schedule.append(row);programs[period]={row,title,time};
      }
      button.append(schedule);button.addEventListener('click',()=>this.navigation.commit(this.slots[key].entry));
      this.slots[key]={button,label:labelNode,number:numberNode,name,logo,schedule,status,programs,entry:null};
    }
    this.nodes=['previous','current','next'].map(key=>this.slots[key].button);
  }
  setContext({current,programs}={}){
    this.current=current;this.programs=programs;
    if(current?.item.kind!=='live')this.metadata.stop();
    this.render();
  }
  render(){
    if(this.rendering)return;this.rendering=true;
    try{
      const live=this.current?.item.kind==='live',preview=live&&this.navigation.isPreviewing();
      const neighbors=live?this.navigation.neighbors():{},selected=live?(this.navigation.selected()||{item:this.current.item,number:this.current.channelNumber}):null;
      // The prepared complete map serves new previews in RAM while valid.
      // Recurring refresh stays limited to the visible/playing selection.
      if(live)this.metadata.start([this.current?.item.id,selected?.item.id,neighbors.previous?.item.id,neighbors.next?.item.id].filter(Boolean).map(String));
      for(const [key,slot] of Object.entries(this.slots)){
        const entry=key==='current'?selected:neighbors[key];slot.entry=entry||null;
        slot.button.hidden=!live;slot.button.disabled=!entry||(key==='current'&&!preview);
        slot.button.dataset.preview=String(key==='current'&&preview);
        slot.number.textContent=entry?number(entry.number):'';slot.number.hidden=!slot.number.textContent;
        slot.name.textContent=entry?text(entry.item.name):'Sem outro canal';
        renderPlayerChannelLogo(slot.logo,entry?.item);
        if(key==='current')slot.label.textContent=preview?'PRÉVIA · OK PARA ASSISTIR':'TV AO VIVO';
        const caption=entry?`${key==='current'&&!preview?'Canal atual':'Assistir canal'} ${number(entry.number)}, ${text(entry.item.name)}`:'Sem outro canal';
        slot.button.setAttribute('aria-label',caption);slot.button.title=caption;
        const active=entry&&String(entry.item.id)===String(this.current?.item.id);
        // The live shared projection can arrive after an empty opening DTO.
        // Prefer that authoritative window, including a legitimate empty one.
        const cached=entry?this.metadata.peek(entry.item.id):null;
        const data=cached||(active?this.programs:null);
        const periods=programWindow(data),hasPrograms=Object.values(periods).some(Boolean);
        slot.schedule.hidden=!entry;slot.status.hidden=hasPrograms;
        const status=data?.status||this.metadata.status();
        slot.status.textContent=status==='loading'?'Carregando programação…':status==='error'?'Não foi possível carregar a programação.':'Programação não informada';
        for(const [period,nodes] of Object.entries(slot.programs)){
          const program=periods[period];nodes.row.hidden=!hasPrograms;
          nodes.title.textContent=program?.title||'Não informada';nodes.title.title=program?.title||'';nodes.time.textContent=program?.startLabel||'';
        }
      }
    }finally{this.rendering=false;}
  }
  reset(){this.metadata.stop();this.current=null;this.programs=null;this.render();}
  destroy(){this.reset();this.metadata.destroy();for(const node of this.nodes)node.remove();}
}
