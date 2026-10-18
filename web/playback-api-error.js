const messages={
  LIVE_RATE_LIMITED:'O provedor limitou esta transmissão. Aguarde antes de tentar novamente.',
  PLAYBACK_RATE_LIMITED:'O provedor limitou esta transmissão. Aguarde antes de tentar novamente.',
  ENGINE_STOPPED:'O serviço de reprodução interrompeu este canal. Aguarde e tente novamente.',
  LIVE_SOURCE_UNAVAILABLE:'O provedor não informou uma fonte compatível para este canal.',
  WPLAY_WEB_UNAVAILABLE:'O player web WPLAY está indisponível no momento. Tente novamente ou escolha outro canal.',
  WPLAY_WEB_START_TIMEOUT:'O player web WPLAY demorou para preparar este canal. Tente novamente.',
  WPLAY_WEB_STOP_UNCONFIRMED:'O serviço ainda não confirmou o encerramento do canal anterior. Aguarde e tente novamente.',
  WPLAY_WEB_RATE_LIMITED:'O serviço solicitou uma pausa antes de abrir outro canal. Aguarde e tente novamente.',
  WPLAY_WEB_AUTH_REJECTED:'O player web WPLAY não autorizou este acesso. Sua conta e sua biblioteca continuam conectadas.',
  WPLAY_WEB_CHANNEL_NOT_FOUND:'Este canal ainda não foi encontrado no player web WPLAY. Escolha outro canal.',
  WPLAY_WEB_CHANNEL_AMBIGUOUS:'Há canais com o mesmo nome no player web WPLAY. Não foi possível identificar este canal com segurança.',
  WPLAY_NATIVE_ENGINE_REQUIRED:'O provedor não informou uma fonte HTTP compatível para este vídeo.'
};
export function localPlaybackMessage(code){
  if(Object.hasOwn(messages,code))return messages[code];
  return null;
}

function responseBody(data){
  try{
    let body=data?.response?.data;
    if(body===undefined)body=data?.networkDetails?.responseText;
    if(typeof body==='string'){if(body.length>16384)return null;body=JSON.parse(body);}
    return body&&typeof body==='object'&&!Array.isArray(body)?body:null;
  }catch{return null;}
}

function responseHeader(data,name){
  for(const source of [data?.networkDetails,data?.response]){
    try{
      const direct=source?.getResponseHeader?.(name),headers=source?.headers;
      if(typeof direct==='string'&&direct.trim())return direct;
      const value=headers?.get?.(name);
      if(typeof value==='string'&&value.trim())return value;
      if(headers&&typeof headers==='object')for(const [key,value] of Object.entries(headers))if(key.toLowerCase()===name.toLowerCase()&&typeof value==='string')return value;
    }catch{/* XHR headers may be unreadable after cancellation. */}
  }
  return null;
}

/** Match the public WPLAY live cooldown without reflecting upstream text. A
 * longer Retry-After is a manual retry, never an earlier automatic request. */
export function playbackRateLimit(data,{now=Date.now(),origin=globalThis.location?.origin}={}){
  const status=Number(data?.response?.code??data?.response?.status??data?.networkDetails?.status);
  if(status!==429||data?.type!=='networkError')return null;
  const header=responseHeader(data,'Retry-After');let requestedMs;
  if(typeof header==='string'&&header.length<=128){
    const value=header.trim();
    requestedMs=/^\d+(?:\.\d+)?$/.test(value)?Number(value)*1000:Date.parse(value)-now;
  }
  if(requestedMs===undefined||Number.isNaN(requestedMs)){
    try{
      const url=new URL(data.url||data.response?.url,origin),seconds=responseBody(data)?.retryAfterSeconds;
      if(url.origin===origin&&url.pathname.startsWith('/api/play/live/')&&typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0)requestedMs=seconds*1000;
    }catch{/* A missing local JSON hint uses the provider's default cooldown. */}
  }
  const waitMs=Math.max(30000,typeof requestedMs==='number'&&!Number.isNaN(requestedMs)?requestedMs:30000);
  return {waitMs,retryAfterMs:waitMs<=35000?waitMs:null};
}

/** Recognize only known local playback errors from the response HLS already
 * received. Never echo upstream messages, URLs or credentials into the UI. */
export function playbackAPIError(data,{origin=globalThis.location?.origin}={}){
  const status=Number(data?.response?.code??data?.response?.status??data?.networkDetails?.status);
  if(![404,409,429,501,502,503,504].includes(status)||data?.type!=='networkError')return null;
  try{
    const url=new URL(data.url||data.response?.url,origin);
    if(url.origin!==origin||!/^\/api\/play\/(?:live|movie|series)\/\d{1,12}(?:\/index\.m3u8|\.[a-z0-9]{2,6})$/.test(url.pathname))return null;
    const body=responseBody(data);
    const message=body&&localPlaybackMessage(body.code);if(!message)return null;
    return {code:body.code,message,terminal:true};
  }catch{return null;}
}
