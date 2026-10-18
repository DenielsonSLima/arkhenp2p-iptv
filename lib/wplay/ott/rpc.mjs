import { ProviderError } from '../../provider.mjs';
import { validUpstreamURL, requestUpstream, readBody } from '../../upstream.mjs';
import {liveRetryAfter} from '../../live-playback-session.mjs';

// Public player.wplayott.com createClientRpc-hwXvz0RK.js uses Seroval JSON.
const escapes={'"':'\\"','\\':'\\\\','\n':'\\n','\r':'\\r','\b':'\\b','\t':'\\t','\f':'\\f','<':'\\x3C','\u2028':'\\u2028','\u2029':'\\u2029'};
const escape=value=>String(value).replace(/["\\\n\r\b\t\f<\u2028\u2029]/g,char=>escapes[char]);
const unescape=value=>String(value).replace(/\\(\\|"|n|r|b|t|f|x3C|u2028|u2029)/g,(_,code)=>({'\\':'\\','"':'"',n:'\n',r:'\r',b:'\b',t:'\t',f:'\f',x3C:'<',u2028:'\u2028',u2029:'\u2029'})[code]);
export function encodeRPC(value) {
  const refs=new Map(),marked=new Set();
  const encode=value=>{
    if(value===null)return {t:2,s:0};if(value===undefined)return {t:2,s:1};if(typeof value==='boolean')return {t:2,s:value?2:3};
    if(typeof value==='string')return {t:1,s:escape(value)};
    if(typeof value==='number')return Number.isFinite(value)?{t:0,s:value}:{t:2,s:Number.isNaN(value)?7:value>0?5:6};
    if(typeof value!=='object')throw new Error('Valor RPC não suportado.');
    if(refs.has(value)){const id=refs.get(value);marked.add(id);return {t:4,i:id};}
    const id=refs.size;refs.set(value,id);
    if(Array.isArray(value))return {t:9,i:id,a:value.map(encode),o:0};
    const entries=Object.entries(value);return {t:10,i:id,p:{k:entries.map(([key])=>escape(key)),v:entries.map(([,value])=>encode(value))},o:0};
  };
  const node=encode(value);return JSON.stringify({t:node,f:127,m:[...marked]});
}
export function decodeRPC(node,refs=new Map()) {
  if(node?.t&&typeof node.t==='object')node=node.t;
  const decode=node=>{
    if(!node||typeof node!=='object'||typeof node.t!=='number')return node;
    switch(node.t){
      case 0:return Number(node.s);case 1:return unescape(node.s);case 2:return [null,undefined,true,false,-0,Infinity,-Infinity,NaN][node.s];case 3:return BigInt(node.s);case 4:return refs.get(node.i);
      case 5:{const value=new Date(node.s);refs.set(node.i,value);return value;}
      case 9:{const value=[];refs.set(node.i,value);for(const item of node.a||[])value.push(decode(item));return value;}
      case 10:case 11:{const value={};refs.set(node.i,value);for(let index=0;index<(node.p?.k.length||0);index++)Object.defineProperty(value,unescape(node.p.k[index]),{value:decode(node.p.v[index]),writable:true,enumerable:true,configurable:true});return value;}
      case 13:case 14:{const value=new Error(unescape(node.m||''));refs.set(node.i,value);return value;}
      case 25:if(node.c==='$TSR/Error'){const value=new Error(decode(node.s?.message)||'Falha no serviço WPlay OTT.');refs.set(node.i,value);return value;}break;
    }
    throw new ProviderError('O player WPlay OTT retornou um formato RPC não reconhecido.','OTT_RPC_FORMAT');
  };
  return decode(node);
}
function decodedResponse(buffer,headers) {
  const type=String(headers['content-type']||'');
  if(type.includes('application/x-tss-framed')){
    const refs=new Map();let first;
    for(let offset=0;offset+9<=buffer.length;){const kind=buffer[offset],id=buffer.readUInt32BE(offset+1),size=buffer.readUInt32BE(offset+5);offset+=9;if(offset+size>buffer.length)throw new ProviderError('Resposta RPC incompleta.','OTT_RPC_FORMAT');if(kind===0&&id===0){const value=decodeRPC(JSON.parse(buffer.subarray(offset,offset+size).toString()),refs);first??=value;}offset+=size;}
    if(first===undefined)throw new ProviderError('O player WPlay OTT retornou uma resposta vazia.','OTT_RPC_FORMAT');return first;
  }
  const value=JSON.parse(buffer.toString());return headers['x-tss-serialized']?decodeRPC(value):value;
}
export class OttRPC {
  constructor(server='https://player.wplayott.com',{allowPrivate=false}={}){this.base=validUpstreamURL(server,allowPrivate);this.base.pathname='/';this.base.search='';this.base.hash='';this.allowPrivate=allowPrivate;this.cookieJar=new Map();}
  cookieHeader(url=this.base){return new URL(url,this.base).origin===this.base.origin?[...this.cookieJar].map(([name,value])=>`${name}=${value}`).join('; '):'';}
  receiveCookies(headers){for(const value of headers['set-cookie']||[]){const parts=value.split(';'),pair=parts.shift(),index=pair.indexOf('=');if(index<1)continue;const name=pair.slice(0,index),cookie=pair.slice(index+1);if(parts.some(part=>/^\s*Max-Age=0\s*$/i.test(part)))this.cookieJar.delete(name);else this.cookieJar.set(name,cookie);}}
  async call(id,{method='GET',data,timeout=20000,signal}={}){
    if(!/^[a-f\d]{64}$/.test(id))throw new Error('Identificador RPC inválido.');
    const url=new URL('/_serverFn/'+id,this.base),headers={'x-tsr-serverFn':'true',Accept:'application/json','Accept-Encoding':'gzip, deflate, br',Origin:this.base.origin,Referer:this.base.origin+'/auth','User-Agent':'Mozilla/5.0'};
    const cookie=this.cookieHeader(url);if(cookie)headers.Cookie=cookie;if(this.accessToken)headers.Authorization='Bearer '+this.accessToken;
    const payload=data===undefined?undefined:encodeRPC({data});let body;
    if(method==='POST'&&payload!==undefined){body=payload;headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(body);}
    else if(method==='GET'&&payload!==undefined)url.searchParams.set('payload',payload);
    const response=await requestUpstream(url,{method,body,headers,timeout,signal,followRedirects:false,allowPrivate:this.allowPrivate});this.receiveCookies(response.headers);
    const buffer=await readBody(response);
    if(response.status===429)throw Object.assign(new ProviderError('O player WPlay OTT solicitou uma pausa.','OTT_RATE_LIMITED',429),{retryAfterSeconds:liveRetryAfter(response.headers['retry-after'])});
    if(response.status!==200)throw new ProviderError(`O player WPlay OTT retornou HTTP ${response.status}.`,'OTT_UPSTREAM_HTTP',[401,403].includes(response.status)?401:502);
    let result;try{result=decodedResponse(buffer,response.headers);}catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError('O player WPlay OTT retornou uma resposta inválida.','OTT_RPC_FORMAT');}
    const error=result instanceof Error?result:result?.error;if(error)throw new ProviderError(error.message||'Não foi possível completar a operação no player WPlay OTT.','OTT_RPC_ERROR',401);
    return result&&Object.hasOwn(result,'result')?result.result:result;
  }
}
