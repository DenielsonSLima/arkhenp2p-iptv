import {SERIES_PLAYBACK_DEFAULTS} from './series-playback-preferences.js';

export const SERIES_AUTOPLAY_CHOICES = [
  {mode:'offset', label:'Antes do fim', description:'Usa os créditos marcados. Sem marcação, inicia a contagem nos últimos segundos configurados abaixo.'},
  {mode:'markers', label:'Somente créditos marcados', description:'Antecipa com uma marcação salva para este episódio. Sem marcação, aguarda o vídeo terminar.'},
  {mode:'ended', label:'Quando terminar', description:'Reproduz o episódio inteiro e só depois mostra a contagem para o próximo.'}
];
const node = (tag, className = '', text) => {const element=document.createElement(tag);element.className=className;if(text!==undefined)element.textContent=text;return element;};

export function seriesPlaybackSummary(preferences = SERIES_PLAYBACK_DEFAULTS) {
  if(!preferences.autoNext)return 'O próximo episódio será iniciado por você.';
  if(preferences.nextMode==='ended')return 'Ao terminar o episódio, você terá 5 segundos para cancelar a reprodução do próximo.';
  if(preferences.nextMode==='markers')return 'Créditos marcados têm contagem de 5 segundos. Sem marcação, a contagem aparece quando o episódio terminar.';
  return `Sem créditos marcados, a contagem de 5 segundos começa nos últimos ${preferences.endOffsetSeconds} segundos. Esse ponto é aproximado e pode incluir cenas.`;
}

/** Update controls in place so preference notifications preserve keyboard focus. */
export function renderSeriesPlaybackPreferences(container, {controller, toast} = {}) {
  const section=node('section','settings-series-playback');let disposed=false;
  section.append(node('h3','','Sua próxima história, sem interrupções'),node('p','settings-note','As preferências ficam salvas neste aparelho e sincronizam com sua conta quando conectada. Você pode cancelar a passagem para o próximo episódio durante a contagem.'));
  const checks=[];
  const checkbox=(key,title,description)=>{
    const row=node('label','settings-series-toggle'),input=node('input');input.type='checkbox';input.disabled=!controller?.setPreferences;
    const copy=node('span');copy.append(node('strong','',title),node('small','',description));row.append(input,copy);section.append(row);checks.push({key,input});
    input.addEventListener('change',()=>save({[key]:input.checked}));return input;
  };
  checkbox('autoNext','Reproduzir o próximo episódio','Ativado por padrão. A contagem dura 5 segundos e pode ser cancelada para este episódio.');
  checkbox('autoSkipOpening','Pular aberturas marcadas automaticamente','Só avança quando início e fim da abertura estiverem marcados neste episódio. Nenhuma abertura é adivinhada.');
  const choices=node('fieldset','settings-series-options');choices.append(node('legend','','Quando iniciar o próximo episódio'));const radios=[];
  for(const {mode,label,description} of SERIES_AUTOPLAY_CHOICES){
    const row=node('label','settings-series-option'),input=node('input');input.type='radio';input.name='series-next-mode';input.value=mode;
    const copy=node('span');copy.append(node('strong','',label),node('small','',description));row.append(input,copy);choices.append(row);radios.push({mode,row,input});
    input.addEventListener('change',()=>{if(input.checked)save({nextMode:mode});});
  }
  section.append(choices);
  const offset=node('label','settings-series-offset'),offsetCopy=node('span');offsetCopy.append(node('strong','','Antecipação aproximada'),node('small','','Usada somente em “Antes do fim” quando os créditos não estiverem marcados. De 5 a 300 segundos.'));
  const seconds=node('input');seconds.type='number';seconds.min='5';seconds.max='300';seconds.step='1';seconds.inputMode='numeric';seconds.setAttribute('aria-label','Segundos antes do fim do episódio');
  const field=node('span','settings-series-offset-field');field.append(seconds,node('span','','segundos'));offset.append(offsetCopy,field);section.append(offset);
  const summary=node('p','settings-series-summary');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
  section.append(summary,node('p','settings-series-explainer','Marque início e fim da abertura e o início dos créditos nos ajustes do player. As marcações pertencem à sua conta e à versão desse episódio; não se aplicam automaticamente aos outros episódios.'));
  const attribution=node('p','settings-note','Marcações comunitárias fornecidas pelo '),source=node('a','','SkipDB');
  source.href='https://skipdb.tv';source.target='_blank';source.rel='noopener noreferrer';
  const openData=node('a','','dados abertos e licença');openData.href='/series-markers/open-data/skipdb.json';openData.target='_blank';openData.rel='noopener noreferrer';
  attribution.append(source,node('span','',' · '),openData);section.append(attribution);
  function update(){
    if(disposed)return;const preferences=controller?.getPreferences?.()||SERIES_PLAYBACK_DEFAULTS;
    for(const {key,input} of checks)input.checked=preferences[key];
    for(const {mode,row,input} of radios){input.checked=preferences.nextMode===mode;input.disabled=!controller?.setPreferences||!preferences.autoNext;row.classList.toggle('selected',input.checked);}
    seconds.value=String(preferences.endOffsetSeconds);seconds.disabled=!controller?.setPreferences||!preferences.autoNext||preferences.nextMode!=='offset';
    summary.textContent=seriesPlaybackSummary(preferences);
  }
  function save(patch){
    if(disposed)return;
    try{controller?.setPreferences?.(patch);}catch{toast?.('Não foi possível salvar a preferência de séries.');}
    update();
  }
  seconds.addEventListener('change',()=>{
    const value=Number(seconds.value);if(!Number.isInteger(value)||value<5||value>300){toast?.('Escolha de 5 a 300 segundos antes do fim.');update();return;}
    save({endOffsetSeconds:value});
  });
  container.append(section);update();const unsubscribe=controller?.subscribe?.(update);
  return()=>{disposed=true;unsubscribe?.();};
}
