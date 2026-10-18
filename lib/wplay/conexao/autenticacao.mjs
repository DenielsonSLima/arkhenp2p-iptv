import {ProviderError} from '../../provider.mjs';
import {validUpstreamURL} from '../../upstream.mjs';

// WPLAYP2P 11.9.0d: td.m.e() POST builder and recovered td.m.i/k/d VM.
// See analysis/WPLAYP2P-11.9.0d-auth-contract.md for the APK offsets.
export const WPLAY_AUTH_URLS=Object.freeze(['https://auth1.wareztv.io/api/v2/auth','https://auth1.authwplays.one/api/v2/auth']);
const PACKAGE='io.wareztv.android.one',APP_NAME='WPlay',VERSION_NAME='11.9.0d',VERSION_CODE=1190;
function deviceText(value,fallback=''){const string=String(value??fallback);if(string.length>200||/[\x00-\x1f\x7f]/.test(string))throw new ProviderError('Identificação do dispositivo inválida.','WPLAY_DEVICE_INVALID',400);return string;}
export function wplayDevice(value={}) {
  const keys=['buildBrand','buildProduct','buildBoard','buildABI','buildDisplay','buildModel','sysVersion'];
  const device=Object.fromEntries(keys.map(key=>[key,deviceText(value[key])]));
  // ic.y.A() uses this literal when Settings.Secure.android_id is unavailable.
  device.deviceID=deviceText(value.deviceID,'did')||'did';
  device.operateMode=Number.isInteger(Number(value.operateMode))?Number(value.operateMode):0;
  return device;
}
export function wplayAuthForm(config) {
  const device=wplayDevice(config.device);
  // be.e.onClick() trims both fields and adds h.d before saving USER/PASSWORD.
  const input=String(config.username).trim(),username=input.includes('@')?input:input+'@wareztv.io';
  return new URLSearchParams({from:'ap',username,password:String(config.password).trim(),deviceID:device.deviceID,packageName:PACKAGE,appName:APP_NAME,appVersion:String(VERSION_CODE),buildBrand:device.buildBrand,buildProduct:device.buildProduct,buildBoard:device.buildBoard,buildABI:device.buildABI,operateMode:String(device.operateMode),buildDisplay:device.buildDisplay,buildModel:device.buildModel,sysVersion:device.sysVersion}).toString();
}
export function wplayUserAgent(device) {return `Apache-HttpClient/Null (${APP_NAME} ${VERSION_NAME}; Android ${device.sysVersion}; ${device.buildModel}; ${device.deviceID})`;}
export function wplayServiceURL(value,token) {
  if(typeof value!=='string'||!value)return '';
  // Recovered td.m.d() deliberately appends the original token verbatim.
  if(!token||value.includes('?t=')||value.includes('&t='))return value;
  return value+(value.indexOf('?')>0?'&t=':'?t=')+String(token);
}

export async function authenticateWplay(client,options={}) {
    const body=wplayAuthForm(client.config);let failure;
    for(const url of client.authURLs){
      try {
        let data;
        if(client.providerAuthenticate){
          try{
            const response=await client.providerAuthenticate({server:url,scopeServer:client.config.server,form:body,userAgent:client.userAgent,signal:options.signal});
            data=response.payload;client.cloudCollection=response.cloudCollector===true;
          }catch(error){
            if(error?.providerAuthFallback!==true||[401,403].includes(error?.remoteStatus)||[401,403].includes(error?.status)||options.signal?.aborted)throw error;
            // Cloud transport is optional; provider authentication remains
            // mandatory, with the same approved URL, form and response checks.
            client.cloudCollection=false;data=await client.requestJSON(url,{method:'POST',body,...options});
          }
        }
        else data=await client.requestJSON(url,{method:'POST',body,...options});
        const hasCode=typeof data?.code==='number'||(typeof data?.code==='string'&&/^-?\d+$/.test(data.code));
        if(!data||typeof data!=='object'||Array.isArray(data)||!hasCode||!Number.isInteger(Number(data.code)))throw new ProviderError('O serviço WPlay retornou uma resposta inválida.','WPLAY_INVALID_RESPONSE');
        if(Number(data.code)!==0){
          const authCode=Number(data.code),missing=authCode===-11,passwordRejected=authCode===-10;
          const message=missing?'Conta não encontrada neste servidor WPlay.':passwordRejected?'Senha não aceita neste servidor WPlay.':'O serviço WPlay não autorizou esta conta. Confira os dados de acesso.';
          const error=new ProviderError(message,missing?'WPLAY_ACCOUNT_NOT_FOUND':passwordRejected?'WPLAY_PASSWORD_REJECTED':'AUTH_REJECTED',401);
          error.authCode=authCode;error.provider='wplay';throw error;
        }
        return data;
      } catch(error){failure=error;if(Number.isInteger(error.authCode)||options.signal?.aborted)throw error;}
    }
    throw failure;
  }

export function resolveWplayAuthURLs(config,{allowPrivate=false}={}){
  const custom=config?.authURLs??(config?.server?[config.server]:null);
  // Extra destinations require an explicit caller selection; no discovered replay.
  const endpoints=(custom||[WPLAY_AUTH_URLS[0]]).map(value=>validUpstreamURL(value,allowPrivate).href);
  if(!endpoints.length||(!allowPrivate&&endpoints.some(value=>!WPLAY_AUTH_URLS.includes(value))))throw new ProviderError('Servidor WPlay não reconhecido pelo contrato do APK.','WPLAY_SERVER_INVALID',400);
  return endpoints;
}
