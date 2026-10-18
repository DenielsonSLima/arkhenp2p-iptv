import {ProviderError,decodeText} from '../../provider.mjs';
import {WPLAY_OTT_RPC} from './contrato.mjs';

const unavailableReply=result=>{
  const message=decodeText(result?.message).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return Number(result?.status)===503||/(?:servidor|server|servico|service|lista).{0,100}(?:indisponivel|unavailable|fora do ar)/.test(message);
};
export async function authenticateWplayOTT(client,{signal}={}){
  let result=await client.rpc.call(WPLAY_OTT_RPC.login,{method:'POST',data:{identifier:client.config.username,password:client.config.password},signal});
  if(result?.authenticated===true){
    if(typeof result.accessToken!=='string'||!result.accessToken)throw new ProviderError('O player WPlay não retornou uma sessão válida.','OTT_SESSION_INVALID');
    client.rpc.accessToken=result.accessToken;client.refreshToken=result.refreshToken;client.member=true;
  } else {
    result=await client.rpc.call(WPLAY_OTT_RPC.legacyLogin,{method:'POST',data:{username:client.config.username,password:client.config.password},signal});
    if(result?.authenticated!==true&&unavailableReply(result))throw new ProviderError('O servidor da lista WPlay está indisponível no momento. Tente novamente em alguns minutos.','OTT_SERVICE_UNAVAILABLE',503);
    if(result?.authenticated!==true)throw new ProviderError('Usuário ou senha não foram aceitos pelo player WPlay.','AUTH_REJECTED',401);
    client.member=false;
  }
  client.authenticatedAt=Date.now();
  client.session={connected:true,account:{status:'Active',expiresAt:null,maxConnections:null,activeConnections:null,usernameMasked:'••••'+client.config.username.slice(-4),provider:'wplay-ott'}};
  return client.session;
}
