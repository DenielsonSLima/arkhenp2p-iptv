const cancelled=()=>new DOMException('A consulta de filmes foi cancelada.','AbortError');

/** Movie catalogue policy. The shared runtime still owns snapshot transport,
 * collection leases, global image references and provider/session fallback. */
export class CatalogoFilmes{
  constructor({cloudRuntime,catalogSearch}={}){Object.assign(this,{cloudRuntime,catalogSearch});}
  async load(state,params,{signal,current=()=>true}={}){
    const client=state.client,runtime=this.cloudRuntime;
    const check=()=>{if(signal?.aborted||!current())throw cancelled();};
    const filter=data=>{check();this.catalogSearch?.remember(client,'movies',data);return state.parental?state.parental.filterCatalog(data,'movies'):data;};
    check();
    if(state.cloud){
      if(params.get('refresh')==='1'){await runtime.refresh(state,'catalog',{media_type:'movies'});check();}
      const paged=params.get('paged')==='1'||params.has('snapshot');
      if(paged){
        const shared=await runtime.filmes.page(state,{category:params.get('category'),page:Number(params.get('page')||1),cursor:Number(params.get('cursor')??-1),snapshotId:params.get('snapshot'),includeAdult:state.parental?.unlocked===true,fresh:params.get('cache')==='reload'});
        check();if(shared)return filter(shared);
      }
      const [shared,model]=await Promise.all([
        runtime.filmes.snapshot(state,{fresh:params.get('cache')==='reload'}),
        runtime.filmes.readModel(state,{signal}).catch(()=>null),
      ]);
      check();
      if(Array.isArray(shared?.items)&&Array.isArray(shared?.categories)){
        const result=filter({...shared,catalogComplete:true});
        if(model?.mediaType==='movies'&&model.snapshotId===shared.pagination?.snapshotId&&Date.parse(model.revisionAt)===Date.parse(shared.pagination?.revisionAt)&&model.includeAdult===(state.parental?.unlocked===true)&&model.total===result.items.length)result.readModel=model;
        return result;
      }
    }
    if(params.get('refresh')==='1')client.invalidateCatalog('movies');
    const category=params.get('category');
    const data=category!==null&&category!=='__all'&&client.catalogPage
      ?await runtime.fallback(state,'catalog',['movies',category,Number(params.get('page')||1)],metadataClient=>metadataClient.catalogPage('movies',category,Number(params.get('page')||1)))
      :await runtime.fallback(state,'catalog',['movies'],metadataClient=>metadataClient.catalog('movies'));
    return filter(data);
  }
  async readModel(state,{signal,current=()=>true}={}){
    let model;try{model=await this.cloudRuntime.filmes.readModel(state,{signal});}catch{/* The last navigation model belongs to its current generation. */}
    if(signal?.aborted||!current())throw cancelled();
    return model||null;
  }
}
