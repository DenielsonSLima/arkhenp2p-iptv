import {withRequestSignals} from '../../request-signals.js';
const QUERY_TTL=30_000;
const PROVIDERS={skipdb:'SkipDB',introdb:'IntroDB'};
const STATUS={running:'Em andamento',ready:'Atualizado',partial:'Concluído com pendências',failed:'Falha na última consulta',idle:'Aguardando sincronização',cooldown:'Aguardando nova tentativa',unknown:'Sem registro recente',pending:'Aguardando identificação',unresolved:'Correspondência não encontrada',resolved:'Identificada'};
const REASONS={not_found:'Não encontrado na fonte',no_match:'Correspondência não encontrada',ambiguous:'Correspondência precisa de revisão',timeout:'A fonte demorou a responder',rate_limited:'Limite de consultas atingido',unverified:'Edição ainda não confirmada',no_markers:'Sem marcações disponíveis',missing_identity:'Identificação pendente'};
const node=(tag,className='',text)=>{const element=document.createElement(tag);element.className=className;if(text!==undefined)element.textContent=text;return element;};
const number=value=>Number.isFinite(value)&&value>=0?value.toLocaleString('pt-BR'):'—';
const date=value=>{const stamp=Date.parse(value);return Number.isFinite(stamp)?new Date(stamp).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'Sem registro';};
const coverageDate=value=>Number.isFinite(Date.parse(value))?`Cobertura atualizada em ${date(value)}`:'Aguardando atualização da cobertura.';
const status=value=>STATUS[value]||'Aguardando atualização';
const aborted=()=>new DOMException('Consulta encerrada.','AbortError');
const scopeKey=scope=>JSON.stringify(['arkhen-marker-sync',scope?.project||'',scope?.providerKey||'',scope?.scopeHash||'']);

export function markerSyncError(error){
  if(error?.status===401)return 'Entre novamente para consultar o registro de sincronização.';
  if(error?.status===403)return 'O registro deste catálogo não está disponível para esta conta.';
  return 'Não foi possível atualizar o registro. Tente novamente em instantes.';
}

function validate(data){
  if(data?.schemaVersion!==1||!data.global||!data.catalog||!Array.isArray(data.providers)||!Array.isArray(data.recent))throw new Error('MARKER_SYNC_RESPONSE_INVALID');
  return data;
}

/** A read-only query, owned by this settings panel. Nothing invalidates catalog,
 * player or personal-library queries. Account transitions discard the snapshot. */
export class MarkerSyncRegistry {
  constructor({api,getScope=()=>({}),loadQueryCore=()=>import('/assets/vendor/cloud-client.js')}={}){
    Object.assign(this,{api,getScope,loadQueryCore});this.epoch=0;this.listeners=new Set();this.client=null;this.clientPromise=null;this.request=null;this.state={data:null,loading:false,error:null};this.scope=null;
  }
  subscribe(listener){this.listeners.add(listener);listener(this.state);return()=>this.listeners.delete(listener);}
  emit(){for(const listener of this.listeners)listener(this.state);}
  async queries(){
    if(!this.clientPromise)this.clientPromise=Promise.resolve().then(()=>this.loadQueryCore()).then(({QueryClient})=>{
      // There is at most one scoped query. Keep the last record while the panel
      // is closed; reset explicitly removes it at every account/scope change.
      this.client=new QueryClient({defaultOptions:{queries:{staleTime:QUERY_TTL,gcTime:Infinity,retry:0,refetchOnWindowFocus:false,refetchOnReconnect:false,networkMode:'always',structuralSharing:false}}});return this.client;
    }).catch(()=>null);
    return this.clientPromise;
  }
  refresh({force=false}={}){
    const key=scopeKey(this.getScope());
    if(this.scope!==null&&this.scope!==key)this.reset();
    this.scope=key;if(this.request)return this.request.promise;
    const request={epoch:this.epoch,scope:key,controller:new AbortController()};this.request=request;
    this.state={...this.state,loading:true,error:null};this.emit();
    const current=()=>this.request===request&&this.epoch===request.epoch&&scopeKey(this.getScope())===request.scope&&!request.controller.signal.aborted;
    request.promise=(async()=>{
      try{
        const client=await this.queries();if(!current())throw aborted();
        const queryKey=JSON.parse(key),queryFn=async({signal}={})=>validate(await withRequestSignals([signal,request.controller.signal],signal=>this.api('/api/markers/sync-status',{signal})));
        const data=client?await client.fetchQuery({queryKey,queryFn,staleTime:force?0:QUERY_TTL}):await queryFn();
        if(current()){this.state={data,loading:false,error:null};this.emit();}return current()?data:null;
      }catch(error){
        if(current()){this.state={...this.state,loading:false,error:markerSyncError(error)};this.emit();}return null;
      }finally{if(this.request===request)this.request=null;}
    })();return request.promise;
  }
  pause(){this.epoch++;this.request?.controller.abort();this.request=null;void this.client?.cancelQueries();this.state={...this.state,loading:false};}
  reset(){this.pause();this.client?.clear();this.scope=null;this.state={data:null,loading:false,error:null};this.emit();}
}

function metric(label,value,detail){const card=node('div','marker-sync-metric');card.append(node('strong','',number(value)),node('span','',label));if(detail)card.append(node('small','',detail));return card;}
function section(title,description){const result=node('section','marker-sync-section');result.append(node('h3','',title),node('p','settings-note',description));return result;}
function sourceLabel(id){return PROVIDERS[id]||'Fonte comunitária';}
function providerCard(provider){
  const card=node('article','marker-sync-provider'),heading=node('div','marker-sync-provider-heading');
  heading.append(node('h4','',sourceLabel(provider.id)),node('span','marker-sync-priority',provider.id==='skipdb'?'1 · Principal':'2 · Alternativa'));
  const badge=node('p','marker-sync-badge',provider.status==='ready'?'Última consulta concluída':status(provider.status));badge.dataset.state=provider.status||'unknown';
  card.append(heading,badge,node('p','marker-sync-provider-access',provider.configured===true?'Acesso configurado':provider.configured===false?'Acesso público':'Configuração ainda não informada'));
  const details=node('dl','marker-sync-provider-details');
  for(const [label,value]of [['Última consulta',date(provider.lastCheckedAt)],['Última resposta recebida',date(provider.lastSuccessAt)]]){const row=node('div');row.append(node('dt','',label),node('dd','',value));details.append(row);}
  if(provider.retryAt){const row=node('div');row.append(node('dt','','Próxima tentativa'),node('dd','',date(provider.retryAt)));details.append(row);}
  card.append(details);if(provider.errorCode)card.append(node('p','marker-sync-provider-note','A última consulta encontrou uma falha. O registro será atualizado na próxima tentativa.'));
  return card;
}

function historyRow(cycle){
  const row=node('tr');row.dataset.cycleId=String(cycle.id||'');
  const result=node('td'),badge=node('span','marker-sync-badge',status(cycle.status));badge.dataset.state=cycle.status||'unknown';result.append(badge);
  if(Number(cycle.failures)>0)result.append(node('small','',`${number(cycle.failures)} consultas com falha`));
  if(cycle.errorCode&&!Number(cycle.failures))result.append(node('small','','Consulta interrompida'));
  row.append(node('td','',date(cycle.occurredAt||cycle.startedAt)),result,node('td','',number(cycle.episodesChecked)),node('td','',number(cycle.skipdb)),node('td','',number(cycle.introdb)),node('td','',number(cycle.empty)));
  return row;
}

function registryContent(data){
  const fragment=node('div','marker-sync-content');
  const sources=section('Fontes de marcações','Consultamos o SkipDB primeiro. Quando a consulta falha ou não encontra marcações, buscamos no IntroDB.');
  const providers=node('div','marker-sync-providers');
  for(const id of ['skipdb','introdb'])providers.append(providerCard(data.providers.find(item=>item.id===id)||{id,status:'unknown'}));sources.append(providers);fragment.append(sources);
  const catalog=section('Cobertura do seu catálogo','Séries e episódios já identificados neste catálogo. A disponibilidade pode variar entre temporadas e versões do episódio.');
  catalog.append(node('p','marker-sync-coverage-note marker-sync-catalog-timestamp',coverageDate(data.catalog.updatedAt)));
  const catalogMetrics=node('div','marker-sync-metrics');
  for(const [label,value,detail]of [['Séries no catálogo',data.catalog.series],['Séries identificadas',data.catalog.identifiedSeries],['Aguardando identificação',data.catalog.pendingSeries],['Episódios com marcações',data.catalog.withMarkers,`${number(data.catalog.episodes)} episódios identificados`]])catalogMetrics.append(metric(label,value,detail));
  catalog.append(catalogMetrics);const pending=Number(data.catalog.unresolvedSeries)||0,failed=Number(data.catalog.failedSeries)||0;
  if(pending||failed)catalog.append(node('p','marker-sync-coverage-note',`${number(pending)} séries sem correspondência confirmada · ${number(failed)} consultas de identificação com falha.`));fragment.append(catalog);
  const global=section('Biblioteca global','Marcações compartilhadas entre os usuários. Estes totais incluem séries que podem não estar no seu catálogo.');
  global.append(node('p','marker-sync-coverage-note marker-sync-global-timestamp',coverageDate(data.global.updatedAt)));
  const globalMetrics=node('div','marker-sync-metrics');for(const [label,value]of [['Séries',data.global.series],['Episódios monitorados',data.global.episodes],['Com abertura marcada',data.global.introEpisodes],['Com créditos marcados',data.global.creditsEpisodes]])globalMetrics.append(metric(label,value));
  global.append(globalMetrics,node('p','marker-sync-coverage-note',`${number(data.global.recapEpisodes)} episódios com recapitulação · ${number(data.global.unverifiedEpisodes)} episódios com edição ainda não confirmada.`),node('p','marker-sync-edition-note','Uma marcação encontrada é uma referência comunitária. O player verifica a compatibilidade com o episódio antes de oferecer o salto.'));fragment.append(global);
  const history=section('Últimos ciclos','Histórico global de consultas e resultados salvos. Os números de cada fonte podem se referir ao mesmo episódio.');
  if(data.recent.length){
    const scroll=node('div','marker-sync-history-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Histórico de sincronização');const table=node('table','marker-sync-history');
    const caption=node('caption','visually-hidden','Últimos ciclos de sincronização global'),head=node('thead'),headRow=node('tr');for(const label of ['Quando','Resultado','Consultados','SkipDB','IntroDB','Sem marcação']){const th=node('th','',label);th.setAttribute('scope','col');headRow.append(th);}head.append(headRow);const body=node('tbody');for(const cycle of data.recent.slice(0,20))body.append(historyRow(cycle));table.append(caption,head,body);scroll.append(table);history.append(scroll);
  }else history.append(node('p','marker-sync-empty','Ainda não há ciclos registrados. Os resultados aparecerão após a próxima sincronização.'));fragment.append(history);
  if(Array.isArray(data.identified)&&data.identified.length){
    const identified=section('Séries identificadas recentemente','Confira as correspondências encontradas para as séries deste catálogo.'),list=node('ul','marker-sync-issues marker-sync-identified');
    for(const item of data.identified.slice(0,20)){
      const row=node('li'),copy=node('div'),imdb=/^tt\d{5,12}$/.test(item.imdbId||'')?` · IMDb ${item.imdbId}`:'';
      copy.append(node('strong','',String(item.title||'Série sem título')),node('span','',`${number(item.withMarkers)} episódios com marcações de ${number(item.episodes)} identificados${imdb}`));row.append(copy,node('time','',date(item.updatedAt)));list.append(row);
    }identified.append(list);fragment.append(identified);
  }
  if(Array.isArray(data.issues)&&data.issues.length){
    const issues=section('Identificações para acompanhar','Pendências recentes das séries deste catálogo.'),list=node('ul','marker-sync-issues');
    for(const issue of data.issues.slice(0,20)){const row=node('li'),copy=node('div');copy.append(node('strong','',String(issue.title||'Série sem título')),node('span','',REASONS[issue.reasonCode]||status(issue.status)));row.append(copy,node('time','',date(issue.updatedAt)));list.append(row);}issues.append(list);fragment.append(issues);
  }
  return fragment;
}

/** Refresh changes only this panel's contents. Its controls, focus and existing
 * results remain mounted while the request runs or fails. */
export function renderMarkerSyncSettings(container,{controller}={}){
  const panel=node('div','marker-sync-settings'),toolbar=node('div','marker-sync-toolbar'),summary=node('div'),badge=node('span','marker-sync-badge','Aguardando registro'),updated=node('p','marker-sync-updated','');summary.append(badge,updated);
  const refresh=node('button','button secondary compact','Atualizar registro');refresh.type='button';let refreshing=false;refresh.addEventListener('click',()=>{if(!refreshing)void controller.refresh({force:true});});toolbar.append(summary,refresh);
  const feedback=node('p','marker-sync-feedback');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
  const content=node('div','marker-sync-results');panel.append(toolbar,feedback,content);container.append(panel);let rendered=null,disposed=false;
  const unsubscribe=controller.subscribe(state=>{
    if(disposed)return;refreshing=state.loading;panel.setAttribute('aria-busy',String(state.loading));refresh.setAttribute('aria-disabled',String(state.loading));refresh.textContent=state.loading?'Atualizando…':'Atualizar registro';
    feedback.dataset.state=state.error?'error':'normal';feedback.textContent=state.error?`${state.error}${state.data?' O último registro disponível continua abaixo.':''}`:state.loading?(state.data?'Consultando atualizações…':'Carregando o registro de sincronização…'):'';
    if(!state.data){
      // A scope/account reset is the only transition that removes a previous
      // record. Ordinary refresh/errors always retain state.data above.
      if(rendered){content.replaceChildren();rendered=null;badge.textContent='Aguardando registro';badge.dataset.state='unknown';updated.textContent='';}
      if(!state.loading&&!state.error)feedback.textContent='O registro ainda não está disponível.';return;
    }
    badge.textContent=status(state.data.status);badge.dataset.state=state.data.status||'unknown';updated.textContent=`Registro consultado em ${date(state.data.generatedAt)}`;
    if(rendered!==state.data){
      const pageX=globalThis.window?.scrollX||0,pageY=globalThis.window?.scrollY||0,scroll=content.querySelector?.('.marker-sync-history-scroll'),historyX=scroll?.scrollLeft||0;
      content.replaceChildren(registryContent(state.data));rendered=state.data;
      const nextScroll=content.querySelector?.('.marker-sync-history-scroll');if(nextScroll)nextScroll.scrollLeft=historyX;
      if(pageX||pageY)globalThis.window?.scrollTo?.({left:pageX,top:pageY,behavior:'instant'});
    }
  });
  void controller.refresh();return()=>{disposed=true;unsubscribe();controller.pause();};
}
