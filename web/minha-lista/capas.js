/** The library already supplies the display order. Recover only the movie and
 * series cards in the current window; TV owns its local logo resolver. */
export function visibleFavoriteArtwork(items,{limit=48}={}){
  const windowSize=Number.isSafeInteger(limit)&&limit>0?limit:48;
  const counts={movie:0,series:0},visible=[];
  for(const item of Array.isArray(items)?items:[]){
    if(!item||!Object.hasOwn(counts,item.kind)||counts[item.kind]>=windowSize)continue;
    counts[item.kind]++;visible.push(item);
  }
  return visible;
}
