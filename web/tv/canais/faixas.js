export const trackName=(track,index)=>track.name||track.label||track.lang||track.language||`Faixa ${index+1}`;
export function tracks(list){try{return Array.from(list||[]);}catch{return [];}}
