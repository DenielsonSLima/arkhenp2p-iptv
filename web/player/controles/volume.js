import {element,icon,control} from '../dom.js';

/** Volume UI over the one shared media element. Account/channel preferences
 * stay with the injected callback; media volumechange only refreshes the UI. */
export class VolumeControl{
  constructor({video,onChange,notify,onAction}={}){
    if(!video)throw new TypeError('O controle de volume precisa do vídeo ativo.');
    Object.assign(this,{video,onChange,notify,onAction});this.destroyed=false;
    this.onClick=()=>this.toggleMute();
    this.button=control('Silenciar','volume',this.onClick);
    this.input=element('input','ip-volume');this.input.type='range';this.input.min='0';this.input.max='1';this.input.step='.05';
    this.input.value=String(video.volume);this.input.setAttribute('aria-label','Volume');
    this.root=element('div','ip-volume-group');this.root.append(this.button,this.input);
    this.onInput=()=>{
      if(this.destroyed)return;
      try{this.video.volume=Number(this.input.value);this.video.muted=false;this.onChange?.(this.video.volume);}
      catch{this.notify?.('O navegador gerencia o volume deste dispositivo.');}
      this.update();this.onAction?.();
    };
    this.onVolumeChange=()=>this.update();
    this.input.addEventListener('input',this.onInput);this.video.addEventListener('volumechange',this.onVolumeChange);this.update();
  }

  update(){
    if(this.destroyed)return;
    const muted=this.video.muted||this.video.volume===0,label=muted?'Ativar áudio':'Silenciar';
    if(this.button.getAttribute('aria-label')!==label){this.button.replaceChildren(icon(muted?'muted':'volume'));this.button.setAttribute('aria-label',label);this.button.title=label;}
    this.button.setAttribute('aria-pressed',String(muted));this.input.value=String(muted?0:this.video.volume);
  }

  toggleMute(){
    if(this.destroyed)return;
    this.video.muted=!this.video.muted;this.update();this.onAction?.();
  }

  destroy(){
    if(this.destroyed)return;this.destroyed=true;
    this.button.removeEventListener('click',this.onClick);this.input.removeEventListener('input',this.onInput);
    this.video.removeEventListener('volumechange',this.onVolumeChange);this.root.remove();
  }
}
