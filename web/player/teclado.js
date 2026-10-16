const editable='input, textarea, select, [contenteditable], details[open], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="combobox"]';
const confirmationKeys=new Set(['Enter','OK','Select','Accept']);

/** Keyboard/remote dispatch only; channel intent belongs to TVPlayerNavigation. */
export function handlePlayerKeydown(player,event){
  if(!player.current)return;player.keyboardMode=true;
  if(player.blockedByDialog()||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||
    event.target?.closest?.(editable)||!player.tools.hidden&&player.tools.contains(event.target))return;
  const key=event.key||'',live=player.current.item.kind==='live';
  const clearDigits=()=>{
    clearTimeout(player.digitTimer);player.digitTimer=null;player.digits='';player.typed.hidden=true;
  };
  if(live&&/^\d$/.test(key)){
    event.preventDefault();player.tvNavigation.cancel({notify:false});player.renderChannelNeighbors();
    player.digits=(player.digits+key).slice(-6);player.typedNumber.textContent=player.digits;player.typed.hidden=false;
    clearTimeout(player.digitTimer);player.digitTimer=setTimeout(()=>player.commitDigits(),1000);player.reveal();return;
  }
  if(live&&['ArrowUp','ArrowDown','ChannelUp','ChannelDown','PageUp','PageDown'].includes(key)){
    if(!player.tools.hidden)return;
    event.preventDefault();clearDigits();player.navigateChannel(['ArrowUp','ChannelUp','PageUp'].includes(key)?1:-1);return;
  }
  if(live&&['ArrowLeft','ArrowRight'].includes(key)){
    if(!player.tools.hidden)return;
    event.preventDefault();clearDigits();player.tvNavigation.browse(key==='ArrowRight'?1:-1);return;
  }
  if(live&&confirmationKeys.has(key)){
    const control=event.target?.closest?.('button, summary, a, [role="button"]');
    const inGuide=player.tvGuide.nodes.some(node=>node===control||node.contains(control));
    if(!control||inGuide){
      if(player.digits){event.preventDefault();player.commitDigits();return;}
      if(player.tvNavigation.isPreviewing()){event.preventDefault();player.tvNavigation.commit();return;}
    }
  }
  if(key===' '&&!event.target?.closest?.('button, summary, a')){event.preventDefault();player.togglePlayback();}
  else if(key.toLowerCase()==='f'){event.preventDefault();player.toggleFullscreen();}
  else if(key.toLowerCase()==='m'){event.preventDefault();player.volumeControl.toggleMute();}
  else if(!live&&['ArrowLeft','ArrowRight'].includes(key)&&Number.isFinite(player.video.duration)){
    event.preventDefault();player.requestSeek(Math.max(0,Math.min(player.video.duration,player.video.currentTime+(key==='ArrowLeft'?-10:10))),{reason:'user'});player.reveal();
  }else player.reveal();
}
