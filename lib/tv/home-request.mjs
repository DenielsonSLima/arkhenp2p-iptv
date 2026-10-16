const channelPattern=/^\d{1,12}$/;
const invalid=()=>Object.assign(new Error('Parâmetros de TV inválidos.'),{status:400,code:'TV_HOME_INVALID_REQUEST'});
const filters=value=>{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>2000||value.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id)))throw invalid();
  return [...new Set(value)];
};
export const homeTvChannelId=value=>typeof value==='string'&&channelPattern.test(value);
export function homeTvRequest(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
  return {hidden:filters(value.hidden),hiddenItems:filters(value.hiddenItems)};
}
export function tvWatchRequest(value={}){
  const scope=homeTvRequest(value);
  if(!homeTvChannelId(value.id)||typeof value.attempt!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.attempt)||typeof value.playing!=='boolean')throw invalid();
  return {...scope,id:value.id,attempt:value.attempt,playing:value.playing};
}
