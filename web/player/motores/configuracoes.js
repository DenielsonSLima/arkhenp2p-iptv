import {playerEnginePreference} from './preferencias.js';

const CHOICES=[
  ['current','Atual — recomendado','Mantém o player usado atualmente neste navegador.'],
  ['shaka','Shaka — experimental','Usa o Shaka para os conteúdos compatíveis. O resultado depende do vídeo e do navegador.']
];
function node(tag,className='',text){
  const element=document.createElement(tag);element.className=className;
  if(text!==undefined)element.textContent=text;return element;
}

export function renderPlayerEnginePreferences(container,{toast}={}){
  const section=node('section','settings-section settings-player-engine');
  section.append(node('h3','','Escolha o player'),node('p','settings-note','A escolha fica salva neste navegador e vale para TV, filmes e séries. A mudança será aplicada ao próximo conteúdo que você abrir.'));
  const choices=node('fieldset','settings-startup-options');
  choices.append(node('legend','visually-hidden','Player para a próxima reprodução'));
  const rows=[],status=node('p','settings-note');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  let disposed=false;
  const update=()=>{
    if(disposed)return;
    const selected=playerEnginePreference.get();
    for(const {input,row} of rows){input.checked=input.value===selected;row.classList.toggle('selected',input.checked);}
  };
  for(const [value,label,description] of CHOICES){
    const row=node('label','settings-startup-option'),input=node('input'),copy=node('span');
    input.type='radio';input.name='player-engine';input.value=value;
    copy.append(node('strong','',label),node('small','',description));
    input.addEventListener('change',()=>{
      if(disposed||!input.checked)return;
      try{
        playerEnginePreference.set(value);
        status.textContent='Preferência salva. A mudança vale para o próximo conteúdo.';
        toast?.(status.textContent);
      }catch{
        status.textContent='Não foi possível salvar a escolha neste navegador. Tente novamente.';
        toast?.(status.textContent);
      }
      update();
    });
    row.append(input,copy);choices.append(row);rows.push({input,row});
  }
  section.append(choices,status,node('p','settings-note','Outro player pode ajudar na compatibilidade, mas não garante o fim das interrupções da internet ou do provedor.'));
  container.append(section);update();
  const unsubscribe=playerEnginePreference.subscribe(update);
  return()=>{disposed=true;unsubscribe();};
}
