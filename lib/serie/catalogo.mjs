const cancelled=()=>new DOMException('A consulta de séries foi cancelada.','AbortError');

/** Series catalogue policy over the existing runtime and provider. Its type,
 * paging/revision and adult filter cannot affect movie or live snapshots. */
export class CatalogoSeries{
  constructor({cloudRuntime,catalogSearch}={}){Object.assign(this,{cloudRuntime,catalogSearch});}
  async load(state,params,{signal,current=()=>true}={}){
    const client=state.client,runtime=this.cloudRuntime;
    const check=()=>{if(signal?.aborted||!current())throw cancelled();};
    const filter=data=>{check();this.catalogSearch?.remember(client,'series',data);return state.parental?state.parental.filterCatalog(data,'series'):data;};
    check();
    if(state.cloud){
      if(params.get('refresh')==='1'){await runtime.refresh(state,'catalog',{media_type:'series'});check();}
      const paged=params.get('paged')==='1'||params.has('snapshot');
      if(paged){
        const shared=await runtime.catalogPage(state,'series',{category:params.get('category'),page:Number(params.get('page')||1),cursor:Number(params.get('cursor')??-1),snapshotId:params.get('snapshot'),includeAdult:state.parental?.unlocked===true,fresh:params.get('cache')==='reload'});
        check();if(shared)return filter(shared);
      }
      const [shared,model]=await Promise.all([
        runtime.catalog(state,'series',{fresh:params.get('cache')==='reload'}),
        runtime.catalogReadModel(state,'series',{signal}).catch(()=>null),
      ]);
      check();
      if(Array.isArray(shared?.items)&&Array.isArray(shared?.categories)){
        const result=filter({...shared,catalogComplete:true});
        if(model?.mediaType==='series'&&model.snapshotId===shared.pagination?.snapshotId&&Date.parse(model.revisionAt)===Date.parse(shared.pagination?.revisionAt)&&model.includeAdult===(state.parental?.unlocked===true)&&model.total===result.items.length)result.readModel=model;
        return result;
      }
    }
    if(params.get('refresh')==='1')client.invalidateCatalog('series');
    const category=params.get('category');
    const data=category!==null&&category!=='__all'&&client.catalogPage
      ?await runtime.fallback(state,'catalog',['series',category,Number(params.get('page')||1)],metadataClient=>metadataClient.catalogPage('series',category,Number(params.get('page')||1)))
      :await runtime.fallback(state,'catalog',['series'],metadataClient=>metadataClient.catalog('series'));
    return filter(data);
  }
  async readModel(state,{signal,current=()=>true}={}){
    let model;try{model=await this.cloudRuntime.catalogReadModel(state,'series',{signal});}catch{/* Preserve the navigation model for its exact current generation. */}
    if(signal?.aborted||!current())throw cancelled();
    return model||null;
  }
}
