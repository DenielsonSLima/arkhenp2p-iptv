import { reconcileChildren } from './catalog-renderer.js';

export function previewNode(tag,className='',text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;}
export function previewText(value){const text=String(value??'').trim();return !text||/^(?:0+(?:[.,]0+)?(?:\s*(?:min(?:utos?)?|mins?|h(?:oras?)?))?|(?:00?:){1,2}00?|null|undefined|n\/?a|none|-)$/i.test(text)?'':text;}
export function previewTitle(name){return String(name||'').replace(/\s*\((?:19|20)\d{2}\)\s*$/,'').trim();}
export function previewYear(item){return String(item.year||'').match(/(?:19|20)\d{2}/)?.[0]||String(item.name||'').match(/\(((?:19|20)\d{2})\)/)?.[1]||'Não informado';}
export function previewRating(item){const rating=Number(item.rating);return Number.isFinite(rating)&&rating>0&&rating<=10?`${rating.toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})} / 10`:'Sem avaliação';}
export function previewFact(label,value,className=''){const fact=previewNode('div',`detail-fact${className?' '+className:''}`);fact.append(previewNode('span','detail-fact-label',label),previewNode('strong','detail-fact-value',value));return fact;}
export function previewButton(text,className,action,graphic){const button=previewNode('button',className);button.type='button';if(graphic)button.append(graphic);button.append(document.createTextNode(text));button.addEventListener('click',action);return button;}

// Shared page chrome. Navigation, provider requests and session state stay in app.
export class PreviewTools {
  constructor({root,background,setArt,icon,onWatch,onFavorite,onRetry,onCatalog}){Object.assign(this,{root,background,setArt,icon,onWatch,onFavorite,onRetry,onCatalog});}
  begin(item,label){
    const backdrop=Array.isArray(item.backdrop)?item.backdrop[0]:item.backdrop;this.setArt(this.background,backdrop||item.poster,!backdrop,item.poster);
    let showcase=this.root.querySelector(':scope>.detail-showcase');
    if(!showcase){showcase=previewNode('div','detail-showcase');showcase.append(previewNode('div','detail-cover'),previewNode('div','detail-summary'));}
    this.setArt(showcase.querySelector('.detail-cover'),item.poster,false);
    const summary=showcase.querySelector('.detail-summary');summary.replaceChildren();summary.append(previewNode('span','eyebrow',label));
    const title=previewNode('h1','',previewTitle(item.name));title.id='detail-title';summary.append(title);return {showcase,summary};
  }
  genre(summary,item){if(previewText(item.genre)){const meta=previewNode('div','detail-meta');meta.append(previewNode('span','',previewText(item.genre)));summary.append(meta);}}
  actions(summary,{continuing=false,enabled=true}={}){
    const actions=previewNode('div','detail-actions'),watch=previewButton(continuing?'Continuar assistindo':'Assistir agora','button primary',this.onWatch,this.icon('play'));watch.disabled=!enabled;
    const favorite=previewButton('Minha lista','button secondary',this.onFavorite,this.icon('plus'));favorite.id='detail-favorite';actions.append(watch,favorite);summary.append(actions);
  }
  information(summary,item){
    summary.append(previewNode('p','detail-plot',previewText(item.plot)||'A sinopse deste título não foi disponibilizada pelo serviço.'));
    if(previewText(item.cast)||previewText(item.director)){
      const credits=previewNode('div','detail-credits');
      for(const [label,value]of [['Direção',item.director],['Elenco',Array.isArray(item.cast)?item.cast.join(', '):item.cast]]){const text=previewText(value);if(!text)continue;const row=previewNode('p');row.append(previewNode('strong','',label+':'),document.createTextNode(text));credits.append(row);}summary.append(credits);
    }
    if(item.error){
      const error=previewNode('p','detail-error',item.error);error.setAttribute('role','alert');summary.append(error);
      if(item.unavailable&&this.onCatalog)summary.append(previewButton('Voltar ao catálogo','button secondary compact',this.onCatalog,this.icon('chevron-left')));
      else if(this.onRetry)summary.append(previewButton('Tentar novamente','button secondary compact',this.onRetry,this.icon('refresh')));
    }
  }
  finish(showcase,sections=[]){reconcileChildren(this.root,[showcase,...sections.filter(Boolean)]);}
  favorite(selected){
    const button=this.root.querySelector('#detail-favorite');if(!button)return;
    button.classList.toggle('selected',selected);button.replaceChildren(this.icon('star'),document.createTextNode(selected?'Nos favoritos':'Favoritar'));button.setAttribute('aria-pressed',String(selected));
  }
}
