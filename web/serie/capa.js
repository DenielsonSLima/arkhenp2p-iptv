import {previewNode} from '../preview-tools.js';
import {artworkURL} from '../channel-artwork.js';

/** Episode artwork stays provider-owned. A series fallback is labelled explicitly. */
export function episodeArtworkSources(episode,series){
  const seen=new Set(),sources=[];
  for(const [kind,values] of [['episode',[episode?.thumbnail,episode?.still,episode?.image,episode?.poster]],['series',[series?.backdrop,series?.poster]]]){
    for(const raw of values.flatMap(value=>Array.isArray(value)?value:[value])){
      const url=artworkURL(raw);if(!url||seen.has(url))continue;seen.add(url);sources.push({url,kind});
    }
  }
  return sources;
}
export function episodeThumbnail(tools,episode,series){
  const thumbnail=previewNode('span','episode-thumbnail'),play=previewNode('span','episode-play');play.append(tools.icon('play'));thumbnail.setAttribute('aria-hidden','true');
  const sources=episodeArtworkSources(episode,series);thumbnail.dataset.artworkKind=sources[0]?.kind||'placeholder';
  if(sources.length){
    const image=previewNode('img','episode-thumbnail-image'),caption=previewNode('span','episode-thumbnail-caption');let index=0;
    image.alt='';image.loading='lazy';image.decoding='async';
    const apply=()=>{const source=sources[index];thumbnail.dataset.artworkKind=source?.kind||'placeholder';caption.textContent=source?.kind==='series'?'Imagem da série':'';caption.hidden=!caption.textContent;if(source){image.src=source.url;image.hidden=false;}else image.hidden=true;};
    image.addEventListener('error',()=>{index++;apply();});apply();thumbnail.append(image,caption);
  }
  thumbnail.append(play);return thumbnail;
}

