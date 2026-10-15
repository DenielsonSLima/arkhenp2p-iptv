export const SETTINGS_SECTIONS = [
  {id:'general',label:'Configurações',icon:'settings',description:'Tudo pronto para a sua próxima sessão.'},
  {id:'profile',label:'Perfil',icon:'user',description:'Seu acesso e os detalhes da sua conta.'},
  {id:'live',label:'TV ao vivo',icon:'tv',description:'Organize seus canais, categorias e favoritos.'},
  {id:'movies',label:'Vídeos',icon:'film',description:'Escolha os filmes que aparecem no seu catálogo.'},
  {id:'series',label:'Séries',icon:'series',description:'Suas séries organizadas do seu jeito.'},
  {id:'series-playback',label:'Reprodução de séries',icon:'play',description:'Aberturas marcadas e o próximo episódio, no seu ritmo.'},
  {id:'playback',label:'Reprodutor',icon:'play',description:'Ajuste a experiência para assistir com conforto.'},
  {id:'audio',label:'Áudio',icon:'audio',description:'Suavize os picos e as diferenças de volume entre canais.'},
  {id:'startup',label:'Inicialização',icon:'power',description:'Decida onde a sua experiência começa.'}
];
export const STARTUP_VIEWS = [
  ['home','Início','Destaques e coleções para descobrir.'],
  ['live','TV ao vivo','Seus canais, prontos para sintonizar.'],
  ['movies','Filmes','Seu cinema em uma única tela.'],
  ['series','Séries','Encontre o próximo episódio.'],
  ['favorites','Minha lista','Comece pelo que você já escolheu.']
];
const paths = {
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  settings:'<path d="m9 3-1 3-3 1-2 3 2 2v3l-1 2 3 2 3-1 2 3 3-1 1-3 3-1 2-3-2-2v-3l1-2-3-2-3 1-2-3z"/><circle cx="12" cy="12" r="3"/>',
  tv:'<rect x="3" y="6" width="18" height="14" rx="2"/><path d="m8 2 4 4 4-4"/>',
  film:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
  series:'<rect x="5" y="7" width="16" height="14" rx="2"/><path d="M17 3H5a2 2 0 0 0-2 2v12m7-6 6 3-6 3z"/>',
  play:'<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  audio:'<path d="m11 5-5 4H3v6h3l5 4V5M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  power:'<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 2M4 17l2 2a8 8 0 0 0 13-2"/>',
  logout:'<path d="M9 4H4v16h5M13 8l4 4-4 4M8 12h13"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>'
};
export function settingsIcon(name){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.innerHTML=paths[name]||paths.settings;return svg;
}
function node(tag,className='',text){const result=document.createElement(tag);result.className=className;if(text!==undefined)result.textContent=text;return result;}
function action(label,run,className='button secondary'){const result=node('button',className,label);result.type='button';result.addEventListener('click',run);return result;}
export function accountSummary(account={}){
  const expires=new Date(account.expiresAt);
  return [
    ['Usuário',account.usernameMasked||'Seu perfil'],
    ['Status',account.status==='Active'?'Ativa':account.status||'Conectada'],
    ['Validade',account.expiresAt&&Number.isFinite(expires.getTime())?new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'long',year:'numeric'}).format(expires):'Não informada'],
    ['Conexões em uso',`${account.activeConnections??0} de ${account.maxConnections??'—'}`]
  ];
}
export function renderProfile(container,options){
  const account=options.getSession?.()?.account||{},card=node('section','settings-profile-card'),avatar=node('div','settings-profile-avatar');avatar.append(settingsIcon('user'));
  const copy=node('div');copy.append(node('span','settings-kicker','SEU PERFIL'),node('h3','',account.usernameMasked||'Sua conta'),node('p','settings-note','Sua sessão está conectada ao catálogo do seu serviço.'));card.append(avatar,copy);container.append(card);
  const details=node('dl','settings-account-details');for(const [label,value]of accountSummary(account)){const row=node('div');row.append(node('dt','',label),node('dd','',value));details.append(row);}container.append(details);
  if(options.getCloudStatus){const cloud=node('section','settings-section'),status=node('p','settings-note',options.getCloudStatus()?.message||'Biblioteca salva neste aparelho.');status.dataset.cloudStatus='';status.setAttribute('role','status');cloud.append(node('h3','','Sua biblioteca'),status);container.append(cloud);}
  const legacy=options.mediaLibrary?.legacySummary();
  if(legacy?.available){
    const section=node('section','settings-section settings-legacy-library');
    section.append(node('h3','','Lista anterior deste navegador'),node('p','settings-note',`Encontramos ${legacy.favorites} favoritos e ${legacy.history} registros de reprodução anteriores que não identificavam a conta. Ao importar, os títulos encontrados no catálogo serão copiados para a conta conectada. Os dados anteriores serão preservados.`));
    const status=node('p','settings-note');status.setAttribute('role','status');
    const importButton=action('Importar lista deste navegador',()=>{
      const imported=options.mediaLibrary.importLegacy();importButton.disabled=true;
      status.textContent=`Importados ${imported.favorites} favoritos e ${imported.history} registros de reprodução.${imported.pending?' Os demais títulos serão conferidos conforme o catálogo carregar.':''}`;
      options.onLibraryChange?.();
    });
    section.append(importButton,status);container.append(section);
  }
  const actions=node('div','settings-profile-actions');actions.append(action('Testar conexão',()=>options.open('connection')),action('Sair da conta',()=>options.logout?.(),'button quiet'));container.append(actions);
}
export function renderStartup(container,{value,onChange}){
  container.append(node('h3','','Sua tela de entrada'),node('p','settings-note','Escolha a primeira tela que aparece depois do login. A preferência fica salva neste navegador.'));
  const choices=node('fieldset','settings-startup-options');choices.append(node('legend','visually-hidden','Tela inicial após o login'));
  for(const [id,label,description]of STARTUP_VIEWS){const choice=node('label','settings-startup-option'),input=node('input');input.type='radio';input.name='startup-view';input.value=id;input.checked=value===id;const copy=node('span');copy.append(node('strong','',label),node('small','',description));choice.classList.toggle('selected',input.checked);input.addEventListener('change',()=>{if(!input.checked)return;for(const row of choices.querySelectorAll('label'))row.classList.toggle('selected',row.contains(input));onChange(id);});choice.append(input,copy);choices.append(choice);}container.append(choices);
}
export function renderGeneral(container,options){
  const intro=node('section','settings-welcome');intro.append(node('span','settings-kicker','À SUA MANEIRA'),node('h3','','Uma experiência que combina com você.'),node('p','settings-note','Personalize seu catálogo, ajuste a reprodução e acompanhe sua conexão.'));container.append(intro);
  const shortcuts=node('div','settings-shortcuts');for(const id of ['profile','live','movies','series','series-playback','playback','audio','startup']){const section=SETTINGS_SECTIONS.find(item=>item.id===id),shortcut=action('',()=>options.open(id),'settings-shortcut'),copy=node('span');copy.append(node('strong','',section.label),node('small','',section.description));shortcut.append(settingsIcon(section.icon),copy,settingsIcon('arrow'));shortcuts.append(shortcut);}container.append(shortcuts);
  const maintenance=node('section','settings-maintenance');maintenance.append(node('h3','','Sua conexão'),node('p','settings-note','Confira o serviço ou atualize as opções disponíveis no seu catálogo.'));const actions=node('div','settings-actions');actions.append(action('Testar conexão',()=>options.open('connection')),action('Atualizar catálogo',()=>options.refresh?.()));maintenance.append(actions);container.append(maintenance);
}
