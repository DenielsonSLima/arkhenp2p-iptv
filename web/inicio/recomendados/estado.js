/** Presentation of a server-owned recommendation shelf, including outages.
 * No local recommendation candidates, genres or scores are calculated here. */
export function homeRecommendationState({data=null,loading=false,error=null,available=false}={}){
  if(Array.isArray(data?.recommendations?.items)&&!loading&&!error)return {phase:'empty',message:'Explore outros títulos para encontrar novas sugestões.',retry:false};
  if(loading)return {phase:'loading',message:'Preparando sugestões para você…',retry:false};
  return {phase:available?'error':'unavailable',message:'As recomendações estão temporariamente indisponíveis.',retry:true};
}

export function renderHomeRecommendationsState(existing,{state,onRetry}={}){
  const root=existing||document.createElement('section');root.retryRecommendation=onRetry;
  const presentation=JSON.stringify(state);if(root.dataset.presentation===presentation)return root;
  root.dataset.presentation=presentation;root.className='shelf home-recommendations-state';root.dataset.shelfKey='home:recommendations-status';root.dataset.phase=state.phase;root.setAttribute('aria-label','Recomendados para você');
  const heading=document.createElement('h2');heading.textContent='Recomendados para você';
  const panel=document.createElement('div');panel.className='home-recommendations-notice';panel.setAttribute('role','status');panel.setAttribute('aria-busy',String(state.phase==='loading'));
  const message=document.createElement('p');message.textContent=state.message;panel.append(message);
  if(state.retry){const retry=document.createElement('button');retry.type='button';retry.className='button secondary';retry.textContent='Tentar novamente';retry.addEventListener('click',()=>root.retryRecommendation?.());panel.append(retry);}
  root.replaceChildren(heading,panel);return root;
}
