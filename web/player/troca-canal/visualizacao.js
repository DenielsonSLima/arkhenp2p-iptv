import {element} from '../dom.js';
import {renderPlayerChannelLogo} from '../../player-channel-logos.js';

const text=value=>String(value??'').trim();
const phases={
  preparing:'Preparando canal',connecting:'Conectando ao canal',
  loading:'Aguardando o vídeo',buffering:'Aguardando o vídeo',switching:'Trocando de canal'
};
const empty=()=>({item:null,channelNumber:null,program:null,phase:'switching'});

/** Presentation of the selected channel only. The owner supplies readiness,
 * programme metadata and visibility; this view has no clock or media policy. */
export class ChannelSwitchView{
  constructor({}={}){
    this.destroyed=false;this.state=empty();
    this.root=element('div','ip-channel-switch');this.node=this.root;this.root.hidden=true;
    this.root.setAttribute('role','status');this.root.setAttribute('aria-live','polite');this.root.setAttribute('aria-atomic','true');
    const identity=element('div','ip-channel-switch-identity');
    this.number=element('span','ip-channel-switch-number');this.number.hidden=true;
    this.logo=element('span','ip-channel-switch-logo');this.logo.hidden=true;
    const copy=element('div','ip-channel-switch-copy');this.name=element('strong','ip-channel-switch-name');this.phase=element('span','ip-channel-switch-phase');
    copy.append(this.name,this.phase);identity.append(this.number,this.logo,copy);
    this.program=element('div','ip-channel-switch-program');this.program.hidden=true;
    const programCopy=element('div','ip-channel-switch-program-copy');
    this.programTitle=element('strong','ip-channel-switch-program-title');this.programTime=element('span','ip-channel-switch-program-time');
    programCopy.append(this.programTitle,this.programTime);this.program.append(element('span','ip-channel-switch-program-label','Agora'),programCopy);
    this.bar=element('div','ip-channel-switch-bar');this.bar.setAttribute('role','progressbar');this.bar.setAttribute('aria-label','Troca de canal em andamento');
    const sweep=element('span','ip-channel-switch-sweep');sweep.setAttribute('aria-hidden','true');this.bar.append(sweep);
    this.root.append(identity,this.program,this.bar);
  }

  show(payload={}){
    if(this.destroyed)return;this.state=empty();this.update(payload);this.root.hidden=false;return this.root;
  }

  update(payload={}){
    if(this.destroyed)return;
    for(const key of ['item','channelNumber','program','phase'])if(Object.hasOwn(payload,key))this.state[key]=payload[key];
    const {item,channelNumber,program,phase}=this.state;
    this.name.textContent=text(item?.name)||'Canal';this.name.title=text(item?.name);
    this.number.textContent=text(channelNumber);this.number.hidden=!this.number.textContent;
    this.number.setAttribute('aria-label',this.number.hidden?'':`Canal ${this.number.textContent}`);
    renderPlayerChannelLogo(this.logo,item);
    const phaseName=Object.hasOwn(phases,phase)?phase:'switching';this.root.dataset.phase=phaseName;this.phase.textContent=phases[phaseName];
    const current=program?.window?program.window.current:program,title=text(current?.title);
    this.program.hidden=false;this.programTitle.textContent=title||'Programação não informada';this.programTitle.title=title;
    this.programTime.textContent=title?[current?.startLabel,current?.endLabel].map(text).filter(Boolean).join(' — '):'';
    this.programTime.hidden=!this.programTime.textContent;return this.root;
  }

  hide(){this.root.hidden=true;}
  destroy(){if(this.destroyed)return;this.hide();this.destroyed=true;this.state=empty();renderPlayerChannelLogo(this.logo,null);this.root.remove();}
}
