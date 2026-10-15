import {artworkURL} from './channel-artwork.js';

const rendered=new WeakMap();

export function playerChannelLogoSources(item) {
  return item?.kind==='live'?[...new Set([item.poster,item.posterOriginal].map(artworkURL).filter(Boolean))]:[];
}

/** Decorative artwork: channel number and name remain the accessible identity. */
export function renderPlayerChannelLogo(container,item) {
  if(!container)return false;
  const sources=playerChannelLogoSources(item),key=`${item?.kind}:${item?.id}:${sources.join('|')}`;
  const previous=rendered.get(container);
  if(previous?.key===key)return !container.hidden;
  const state={key,index:0};rendered.set(container,state);container.replaceChildren();container.hidden=true;
  if(!sources.length)return false;
  const image=(container.ownerDocument || document).createElement('img');
  image.alt='';image.decoding='async';image.setAttribute('aria-hidden','true');
  image.addEventListener('error',()=>{
    if(rendered.get(container)!==state)return;
    if(++state.index<sources.length)image.src=sources[state.index];
    else{container.hidden=true;image.removeAttribute('src');}
  });
  image.src=sources[0];container.append(image);container.hidden=false;return true;
}
