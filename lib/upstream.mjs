import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import {runtimeSessionContext} from './runtime-session-context.mjs';

export function publicAddress(address) {
  const value = address.toLowerCase().replace(/^::ffff:/,'');
  if (isIP(value) === 4) {
    const [a,b] = value.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19)));
  }
  return isIP(value) === 6 && !/^(::|fc|fd|fe[89ab]|ff)/i.test(value);
}

export function validUpstreamURL(value, allowPrivate=false) {
  let url; try { url = new URL(value); } catch { throw new Error('Endereço do servidor inválido.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (!allowPrivate && (hostname==='localhost' || hostname.endsWith('.localhost') || (isIP(hostname) && !publicAddress(hostname))))) throw new Error('Endereço do servidor inválido.');
  return url;
}

export async function requestUpstream(value, options={}, redirects=0) {
  const lease=runtimeSessionContext();
  if(lease){lease.assert();options={...options,signal:options.signal?AbortSignal.any([options.signal,lease.signal]):lease.signal};}
  const url = validUpstreamURL(value, options.allowPrivate);
  if (redirects>5) throw new Error('O servidor redirecionou a conexão muitas vezes.');
  const response = await new Promise((resolve,reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method:options.method || 'GET',
      headers:{'User-Agent':'ARKEHN-P2-IPTV/1.0 Local Player','Accept-Encoding':'identity',...options.headers},
      lookup(hostname, settings, callback) {
        lookup(hostname,{all:true},(error, addresses) => {
          if(error) {callback(error);return;}
          if(!addresses.length || (!options.allowPrivate && addresses.some(a=>!publicAddress(a.address)))) {callback(new Error('Destino de rede não permitido.'));return;}
          if(settings.all) callback(null,addresses);
          else {const selected=addresses.find(a=>a.family===4)||addresses[0];callback(null,selected.address,selected.family);}
        });
      },
      signal:options.signal
    },resolve);
    req.setTimeout(options.timeout || 25000,()=>req.destroy(new Error('Tempo de conexão excedido.')));
    req.on('error',reject);req.end(options.body);
  });
  if (options.followRedirects!==false && [301,302,303,307,308].includes(response.statusCode) && response.headers.location) {
    const target = new URL(response.headers.location,url);response.destroy();
    let redirected=options;
    if(target.origin!==url.origin&&options.headers){
      const headers=Object.fromEntries(Object.entries(options.headers).filter(([key])=>!['cookie','authorization','proxy-authorization','host'].includes(key.toLowerCase())));
      redirected={...options,headers};
    }
    return requestUpstream(target,redirected,redirects+1);
  }
  let body = response;
  const encoding = response.headers['content-encoding'];
  if(encoding==='gzip') body=response.pipe(createGunzip());
  else if(encoding==='deflate')body=response.pipe(createInflate());
  else if(encoding==='br')body=response.pipe(createBrotliDecompress());
  if(body!==response) {
    const fail=error=>body.destroy(error);
    response.once('error',fail);
    response.once('aborted',()=>fail(new Error('Resposta do provedor interrompida.')));
    body.once('close',()=>{response.removeListener('error',fail);response.destroy();});
  }
  return {status:response.statusCode,headers:response.headers,body,url:url.href};
}

export async function readBody(response, limit=64*1024*1024, onChunk) {
  let total=0;const chunks=[];
  for await(const chunk of response.body) {if(typeof onChunk==='function')onChunk(chunk);total+=chunk.length;if(total>limit){response.body.destroy();throw new Error('Resposta do servidor excedeu o tamanho permitido.');}chunks.push(chunk);}
  return Buffer.concat(chunks);
}
