const messages={
  WPLAY_WEB_UNAVAILABLE:'O player web WPLAY está indisponível no momento. Tente novamente ou escolha outro canal.',
  WPLAY_WEB_START_TIMEOUT:'O player web WPLAY demorou para preparar este canal. Tente novamente.',
  WPLAY_WEB_AUTH_REJECTED:'O player web WPLAY não autorizou este acesso. Sua conta e sua biblioteca continuam conectadas.',
  WPLAY_WEB_CHANNEL_NOT_FOUND:'Este canal ainda não foi encontrado no player web WPLAY. Escolha outro canal.',
  WPLAY_WEB_CHANNEL_AMBIGUOUS:'Há canais com o mesmo nome no player web WPLAY. Não foi possível identificar este canal com segurança.',
  NATIVE_BRIDGE_UNAVAILABLE:'Este canal precisa do serviço P2P local, que não está disponível neste dispositivo.',
  NATIVE_BRIDGE_CONFIGURATION:'O serviço P2P local precisa ser configurado neste dispositivo para reproduzir este canal.',
  WPLAY_NATIVE_ENGINE_REQUIRED:'Este canal precisa do serviço P2P local, que não está disponível neste dispositivo.',
  ENGINE_NOT_INITIALIZED:'O serviço P2P local ainda não está pronto para reproduzir este canal.',
  NATIVE_ACCOUNT_MISMATCH:'A conta do serviço P2P local é diferente da conta conectada. Entre com a mesma conta para assistir.',
  NATIVE_ENGINE_CERTIFICATION_REQUIRED:'O serviço P2P recusou a autorização deste dispositivo para reproduzir o canal.',
  NATIVE_BRIDGE_BUSY:'O serviço P2P local está em uso por outra sessão. Encerre essa reprodução para assistir aqui.',
  NATIVE_ENGINE_FAILED:'O serviço P2P local não conseguiu iniciar este canal. Tente novamente ou escolha outro canal.'
};

/** Recognize only known local playback errors from the response HLS already
 * received. Never echo upstream messages, URLs or credentials into the UI. */
export function playbackAPIError(data,{origin=globalThis.location?.origin}={}){
  const status=Number(data?.response?.code??data?.response?.status??data?.networkDetails?.status);
  if(![404,409,501,502,503,504].includes(status)||data?.type!=='networkError')return null;
  try{
    const url=new URL(data.url||data.response?.url,origin);
    if(url.origin!==origin||!/^\/api\/play\/(?:live|movie|series)\/\d{1,12}(?:\/index\.m3u8|\.[a-z0-9]{2,6})$/.test(url.pathname))return null;
    let body=data.response?.data;
    if(body===undefined)body=data.networkDetails?.responseText;
    if(typeof body==='string'){if(body.length>16384)return null;body=JSON.parse(body);}
    if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(messages,body.code))return null;
    return {code:body.code,message:messages[body.code],terminal:true};
  }catch{return null;}
}
