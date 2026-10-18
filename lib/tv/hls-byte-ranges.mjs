/** Preserve HLS byte ranges before each segment receives its opaque proxy URI.
 * RFC 8216 permits an omitted offset only for the same previous resource.
 * No inferred offset crosses a different resource or a non-range segment. */
export function explicitLiveByteRanges(text,base){
  const maximum=(1n<<64n)-1n;
  const lines=text.split(/\r?\n/);let pending=null,previous=null;
  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    if(line.startsWith('#EXT-X-BYTERANGE:')){
      const match=/^#EXT-X-BYTERANGE:([0-9]{1,20})(?:@([0-9]{1,20}))?$/.exec(line);
      const length=match?BigInt(match[1]):0n,offset=match?.[2]===undefined?null:BigInt(match[2]);
      pending=match&&length>0n&&length<=maximum&&(offset===null||offset<=maximum)?{index,length,offset}:null;
    }else if(line.trim()&&!line.startsWith('#')){
      const uri=new URL(line.trim(),base).href;
      if(pending){
        const offset=pending.offset??(previous?.uri===uri?previous.end:null);
        if(offset!==null&&offset<=maximum&&offset+pending.length-1n<=maximum){
          if(pending.offset===null)lines[pending.index]=`#EXT-X-BYTERANGE:${pending.length}@${offset}`;
          previous={uri,end:offset+pending.length};
        }else previous=null;
      }else previous=null;
      pending=null;
    }
  }
  return lines.join('\n');
}
