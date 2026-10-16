import {icon,control} from '../dom.js';

/** Play/pause presentation only. Source ownership, retries and authorization
 * remain with the shared playback session rather than this button. */
export class PlaybackControl{
  constructor({video,onAction,notify}={}){
    if(!video)throw new TypeError('O controle de reprodução precisa do vídeo ativo.');
    Object.assign(this,{video,onAction,notify});this.destroyed=false;
    this.onClick=()=>this.toggle();this.onMediaChange=()=>this.update();
    this.button=control('Reproduzir','play',this.onClick);this.button.classList.add('ip-play');
    for(const event of ['play','pause','ended'])this.video.addEventListener(event,this.onMediaChange);this.update();
  }

  update(){
    if(this.destroyed)return;
    const paused=this.video.paused||this.video.ended,label=paused?'Reproduzir':'Pausar';
    if(this.button.getAttribute('aria-label')!==label){this.button.replaceChildren(icon(paused?'play':'pause'));this.button.setAttribute('aria-label',label);this.button.title=label;}
  }

  toggle(){
    if(this.destroyed)return;this.onAction?.();
    if(this.video.paused||this.video.ended){
      const failed=()=>{if(!this.destroyed)this.notify?.('Pressione reproduzir novamente para iniciar o vídeo.');};
      try{Promise.resolve(this.video.play()).catch(failed);}catch{failed();}
    }else this.video.pause();
  }

  destroy(){
    if(this.destroyed)return;this.destroyed=true;this.button.removeEventListener('click',this.onClick);
    for(const event of ['play','pause','ended'])this.video.removeEventListener(event,this.onMediaChange);this.button.remove();
  }
}
