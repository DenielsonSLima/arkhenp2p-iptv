import {allSeriesEpisodes} from './series-preview.js';

/** History and watch URLs can enter playback before a series preview exists. */
export async function loadSeriesPlaybackSequence({item,episode,getDetails,isCurrent=()=>true,onUpdate=()=>{}}={}){
  if(item?.kind!=='series'||!episode)return null;
  try{
    const details=await getDetails(item);
    if(!isCurrent())return null;
    const episodes=allSeriesEpisodes(details),index=episodes.findIndex(value=>String(value.id)===String(episode.id));
    const sequence={episode:index>=0?episodes[index]:episode,next:index>=0?episodes[index+1]??null:null,status:index>=0?'ready':'unavailable'};
    onUpdate(sequence);return sequence;
  }catch{
    if(!isCurrent())return null;
    const sequence={episode,next:null,status:'unavailable'};onUpdate(sequence);return sequence;
  }
}
