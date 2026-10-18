const failure=(code,extra={})=>Object.assign(new Error(code),{code,...extra});

/** Parse one bounded source object at a time. A 31 MB dump never exists as
 * bytes + text + its complete contributor-bearing object tree in memory. */
export async function openPublicDump(request=globalThis.fetch){
  const allowed=new Set(['skipdb.tv','api.skipdb.tv','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);let url='https://skipdb.tv/api/dump',response;
  for(let count=0;count<6;count++){
    const target=new URL(url);if(target.protocol!=='https:'||!allowed.has(target.hostname)||target.username||target.password)throw failure('DUMP_REDIRECT_REJECTED');
    response=await request(url,{redirect:'manual',headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel?.();if(!location)throw failure('DUMP_REDIRECT_INVALID');url=new URL(location,url).href;continue;}break;
  }
  if(!response?.ok||Number(response.headers.get('content-length'))>64*1024*1024)throw failure('DUMP_HTTP_FAILED');
  return response;
}
export async function readPublicDump(request=globalThis.fetch){
  const response=await openPublicDump(request);
  const reader=response.body.getReader(),decoder=new TextDecoder(),segments=[];let buffer='',head='',tail='',phase='head',bytes=0,objects=0,depth=0,quoted=false,escape=false,scan=0;
  const consume=()=>{
    if(phase==='head'){
      const match=/"segments"\s*:\s*\[/.exec(buffer);if(!match){if(buffer.length>262144)throw failure('DUMP_HEADER_INVALID');return;}
      head=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);phase='items';
    }
    while(phase==='items'){
      if(!depth){buffer=buffer.replace(/^[\s,]+/,'');scan=0;if(!buffer.length)return;if(buffer[0]===']'){tail=buffer.slice(1);buffer='';phase='tail';return;}if(buffer[0]!=='{')throw failure('DUMP_SEGMENT_INVALID');}
      let complete=false;
      for(;scan<buffer.length;scan++){
        const char=buffer[scan];if(quoted){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')quoted=false;continue;}
        if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){
          const raw=JSON.parse(buffer.slice(0,scan+1));if(++objects>250000)throw failure('DUMP_TOO_MANY_SEGMENTS');
          if(raw.status==='approved'&&raw.media_type==='series')segments.push({id:raw.id,status:raw.status,media_type:raw.media_type,imdb_id:raw.imdb_id,season:raw.season,episode:raw.episode,segment_type:raw.segment_type,start_ms:raw.start_ms,end_ms:raw.end_ms,duration_ms:raw.duration_ms,score:raw.score});
          buffer=buffer.slice(scan+1);scan=0;complete=true;break;
        }
      }
      if(!complete){if(buffer.length>1048576)throw failure('DUMP_SEGMENT_TOO_LARGE');return;}
    }
  };
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>64*1024*1024)throw failure('DUMP_TOO_LARGE');
      const text=decoder.decode(value,{stream:true});if(phase==='tail')tail+=text;else{buffer+=text;consume();}if(tail.length>262144)throw failure('DUMP_TRAILER_INVALID');}
    const last=decoder.decode();if(phase==='tail')tail+=last;else{buffer+=last;consume();}
    if(phase!=='tail')throw failure('DUMP_INCOMPLETE');let metadata;try{metadata=JSON.parse(head+'"segments":[]'+tail);}catch{throw failure('DUMP_SCHEMA_INVALID');}
    if(metadata.count!==objects)throw failure('DUMP_COUNT_MISMATCH');return {...metadata,count:segments.length,sourceCount:objects,segments,sourceBytes:bytes};
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
