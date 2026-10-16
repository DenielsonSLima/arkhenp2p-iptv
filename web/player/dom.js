const SVG_NS='http://www.w3.org/2000/svg';
const ICONS={
  play:['M9 5l10 7-10 7V5'],pause:['M8 5v14M16 5v14'],
  close:['M6 6l12 12M6 18L18 6'],volume:['M11 5L6 9H3v6h3l5 4V5','M15 8a6 6 0 010 8M18 5a10 10 0 010 14'],
  muted:['M11 5L6 9H3v6h3l5 4V5','M16 9l5 6M16 15l5-6'],
  expand:['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
  next:['M5 5l10 7-10 7V5M19 5v14'],
  'chevron-left':['M15 5l-7 7 7 7'],'chevron-right':['M9 5l7 7-7 7'],
  settings:['M9 3l-.7 2.1-2 .9-2-.5-2 3.5 1.4 1.6v2.3L2.3 14.5l2 3.5 2-.5 2 .9L9 21h4l.7-2.1 2-.9 2 .5 2-3.5-1.4-1.6v-2.3l1.4-1.6-2-3.5-2 .5-2-.9L13 3H9','M14 12a3 3 0 11-6 0 3 3 0 016 0']
};

export function element(tag,className='',value){
  const node=document.createElement(tag);node.className=className;
  if(value!==undefined)node.textContent=value;return node;
}

export function icon(name){
  const svg=document.createElementNS(SVG_NS,'svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  for(const d of ICONS[name]||ICONS.play){const path=document.createElementNS(SVG_NS,'path');path.setAttribute('d',d);svg.append(path);}
  return svg;
}

export function control(label,name,action){
  const button=element('button','ip-button');button.type='button';
  button.setAttribute('aria-label',label);button.title=label;button.append(icon(name));
  if(typeof action==='function')button.addEventListener('click',action);return button;
}
