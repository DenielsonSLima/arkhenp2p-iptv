/** Normalize only supplied season/episode identities; never invent missing rows. */
export function seasonNumber(value){
  if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))return null;
  const number=Number(value);return Number.isSafeInteger(number)&&number>=0?number:null;
}
export function providedSeriesSeasons(data){
  const seasons=new Map(),seenEpisodes=new Set();
  for(const source of Array.isArray(data?.seasons)?data.seasons:[]){
    const number=seasonNumber(source?.number);if(number===null||!Array.isArray(source?.episodes))continue;
    if(!seasons.has(number))seasons.set(number,{...source,number,episodes:[]});
    for(const raw of source.episodes){
      const id=String(raw?.id??'');if(!raw||typeof raw!=='object'||!/^\d{1,12}$/.test(id)||seenEpisodes.has(id))continue;
      seenEpisodes.add(id);seasons.get(number).episodes.push({...raw,id,season:seasonNumber(raw.season)??number});
    }
  }
  return [...seasons.values()].sort((first,second)=>first.number-second.number);
}
export function computeSeriesStats(data){const seasons=providedSeriesSeasons(data);return {seasonCount:seasons.length,episodeCount:seasons.reduce((total,season)=>total+season.episodes.length,0)};}
