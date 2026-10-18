import {decodeText} from '../../provider.mjs';
import {mediaDuration} from '../../media-duration.mjs';
import {nativeEpisodeID} from '../vod/catalogo-nativo.mjs';

const EPISODE_PATTERN=/[ST](\d+)-?E(\d+)/;
const text=value=>decodeText(value&&typeof value==='object'?value.init??value.i18n?.en??'':value);
export const wplayEpisodeParts=source=>String(source?.subTitle??'').match(EPISODE_PATTERN);

/** Register the provider's exact episode source privately; public episode DTOs
 * retain native IDs without leaking source addresses or deriving parent time. */
export function wplaySeriesSeasons(client,item,raw){
  const seasons=new Map();
  for(const [index,source] of client.sources(raw).entries()){
    const match=wplayEpisodeParts(source),episodeID=nativeEpisodeID(item.id,source,index);if(!match)continue;
    const season=Number(match[1]),number=Number(match[2]);if(!seasons.has(season))seasons.set(season,new Map());
    if(seasons.get(season).has(number))continue;
    const thumbnail=[source.thumbnail,source.still,source.image,source.poster,source.cover].map(value=>client.image(value)).find(Boolean)||'';
    const episode={id:episodeID,title:text(source.subTitle),number,season,...mediaDuration(source),container:'mp4',...(thumbnail?{thumbnail}:{})};
    seasons.get(season).set(number,episode);client.episodes.set(episodeID,{...episode,source});
  }
  return [...seasons].sort(([a],[b])=>a-b).map(([number,entries])=>({number,name:`Temporada ${number}`,episodes:[...entries.values()].sort((a,b)=>a.number-b.number)}));
}
