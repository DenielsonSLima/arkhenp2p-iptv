// Only operations that can use a committed checkpoint belong here. Source
// selection, playlist rewriting, authentication and PIN changes remain writers.
export function runtimeSessionReadPolicy(req,url){
  if(['GET','HEAD'].includes(req.method)){
    if(url.pathname.startsWith('/api/asset/'))return state=>{
      const asset=state.client?.assets?.get(url.pathname.slice(11));
      return typeof asset?.key==='string'&&asset.key.length>0&&!state.client?.playback?.controller?.signal?.aborted&&
        Number.isFinite(asset?.mediaDurationSeconds)&&asset.mediaDurationSeconds>0&&
        asset.key===state.client?.playback?.key;
    };
    if(url.pathname==='/api/playback/status'||url.pathname==='/api/image')return true;
    if(/^\/api\/(?:shared|sports)-image\/[a-f0-9]{64}$/.test(url.pathname)||
      ['/api/catalog/read-model','/api/catalog/revision','/api/tv/guide'].includes(url.pathname)||
      url.pathname==='/api/catalog'&&url.searchParams.get('refresh')!=='1')return state=>Boolean(state.cloud);
  }
  if(req.method==='POST'&&['/api/home/library','/api/tv/home'].includes(url.pathname))return state=>Boolean(state.cloud);
  return false;
}
