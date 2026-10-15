/** A brief, non-modal offer after a saved position actually starts playing. */
export class ResumePrompt {
  constructor({video,onRestart,document=globalThis.document,setTimer=(callback,delay)=>globalThis.setTimeout(callback,delay),clearTimer=timer=>globalThis.clearTimeout(timer),duration=5000}) {
    Object.assign(this,{video,onRestart,document,setTimer,clearTimer,duration});
    this.root=document.createElement('div');this.root.className='resume-prompt';this.root.hidden=true;
    this.button=document.createElement('button');this.button.type='button';this.button.className='resume-prompt-button';this.button.textContent='Começar do início';
    this.root.append(this.button);this.timer=null;this.epoch=0;this.pending=false;this.focused=false;
    this.listeners=[];
    const listen=(target,name,callback)=>{target.addEventListener(name,callback);this.listeners.push(()=>target.removeEventListener(name,callback));};
    for(const name of ['playing','timeupdate','seeked'])listen(video,name,()=>this.update());
    listen(this.button,'click',()=>{if(this.root.hidden)return;this.dismiss();this.onRestart?.();});
    // A keyboard/TV user can finish the action without losing the focused button.
    listen(this.button,'focus',()=>{this.focused=true;this.clear();});
    listen(this.button,'blur',()=>{this.focused=false;if(!this.root.hidden)this.expire();});
  }
  clear(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
  attach({time=0}={}){this.reset();if(Number.isFinite(time)&&time>5){this.target=time;this.pending=true;}}
  update(){
    if(!this.pending||this.video.paused||this.video.seeking||this.video.readyState<2||!Number.isFinite(this.video.currentTime)||this.video.currentTime<this.target-2)return;
    this.pending=false;this.root.hidden=false;if(!this.focused)this.expire();
  }
  expire(){const epoch=this.epoch;this.clear();this.timer=this.setTimer(()=>{if(epoch===this.epoch)this.dismiss();},this.duration);}
  dismiss(){this.epoch++;this.clear();this.pending=false;this.root.hidden=true;}
  reset(){this.dismiss();this.target=0;this.focused=false;}
  destroy(){this.reset();for(const dispose of this.listeners)dispose();this.root.remove();}
}
