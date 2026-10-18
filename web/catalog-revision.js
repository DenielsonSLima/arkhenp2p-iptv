const TYPES=Object.freeze(['live','movies','series']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// The full snapshot/read-model API normalizes timestamps to milliseconds.
// Compare compact headers and Realtime hints using that same contract; the
// snapshot UUID still distinguishes publications within one millisecond.
export function catalogRevisionToken(value){
  if(typeof value!=='string'||value.length>80)return null;
  const time=Date.parse(value);if(!Number.isFinite(time)||time<=0)return null;
  return String(time);
}
export function compareCatalogRevisions(left,right){
  const a=catalogRevisionToken(left),b=catalogRevisionToken(right);if(!a||!b)return NaN;
  return Math.sign(Number(a)-Number(b));
}
export function normalizeCatalogPublication(value,{type,includeAdult}={}){
  if(!TYPES.includes(type)||typeof includeAdult!=='boolean'||value?.complete!==true||value.mediaType!==type||value.includeAdult!==includeAdult||typeof value.snapshotId!=='string'||!UUID.test(value.snapshotId)||!catalogRevisionToken(value.revisionAt)||!catalogRevisionToken(value.expiresAt))return null;
  return {mediaType:type,snapshotId:value.snapshotId.toLowerCase(),revisionAt:new Date(value.revisionAt).toISOString(),expiresAt:new Date(value.expiresAt).toISOString(),includeAdult,complete:true};
}
export function catalogHasPublication(catalog){
  return catalog?.catalogComplete===true&&catalog.preparing!==true&&catalog.pagination?.preparing!==true&&catalog.pagination?.complete!==false&&catalog.pagination?.source==='supabase'&&typeof catalog.pagination?.snapshotId==='string'&&UUID.test(catalog.pagination.snapshotId)&&!!catalogRevisionToken(catalog.pagination?.revisionAt);
}
export function catalogMatchesPublication(catalog,publication,scope){
  const value=normalizeCatalogPublication(publication,scope);
  return !!value&&catalogHasPublication(catalog)&&catalog.pagination.snapshotId.toLowerCase()===value.snapshotId&&compareCatalogRevisions(catalog.pagination.revisionAt,value.revisionAt)===0;
}

export const CATALOG_REVISION_FAILURE_COOLDOWN_MS=30000;
