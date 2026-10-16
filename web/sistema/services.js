/** One same-origin JSON transport. Authentication remains in the server's
 * cookie/session; callers own their AbortSignal and domain lifecycle. */
export class ApplicationServices{
  constructor({fetch=(...args)=>globalThis.fetch(...args)}={}){this.fetch=fetch;}
  async request(path,options={}){
    if(typeof path!=='string'||!path.startsWith('/api/')||/[\\\r\n]/.test(path))throw new TypeError('Rota da aplicação inválida.');
    const response=await this.fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
    let body;try{body=await response.json();}catch{throw new Error('O servidor não retornou uma resposta válida.');}
    if(!response.ok)throw Object.assign(new Error(body.error||body.message||'Não foi possível completar a conexão.'),
      {status:response.status,code:body.code,...(Number.isFinite(body.retryAfterSeconds)?{retryAfterSeconds:body.retryAfterSeconds}:{})});
    return body;
  }
}
