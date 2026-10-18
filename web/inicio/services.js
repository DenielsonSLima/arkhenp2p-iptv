import {withRequestSignals} from '../request-signals.js';

import {homeVODScopeKey as scopeKey} from './biblioteca/scope.js';
const cancelled=()=>new DOMException('A consulta do início foi encerrada.','AbortError');

/** Home's private projection uses the existing same-origin authenticated
 * backend. It never creates Auth, a provider session or another catalogue. */
export class HomeServices{
  constructor({request,getScope=()=>null}={}){
    Object.assign(this,{request,getScope});this.scope=null;this.epoch=0;this.controllers=new Set();
    this.api=(path,options={})=>{
      if(path!=='/api/home/library')return Promise.reject(new Error('HOME_SERVICE_ROUTE_UNSUPPORTED'));
      let input;try{input=JSON.parse(options.body||'{}');}catch{return Promise.reject(new TypeError('Preferências do início inválidas.'));}
      return this.library({...input,signal:options.signal});
    };
  }
  synchronizeScope(){const key=scopeKey(this.getScope());if(key!==this.scope){this.reset();this.scope=key;}return key;}
  async library({hidden={},hiddenItems={},signal}={}){
    const scope=this.synchronizeScope();if(!scope||signal?.aborted||typeof this.request!=='function')throw cancelled();
    const controller=new AbortController(),epoch=this.epoch;this.controllers.add(controller);
    try{
      const value=await withRequestSignals([signal,controller.signal],signal=>this.request('/api/home/library',{
        method:'POST',body:JSON.stringify({hidden,hiddenItems}),signal}));
      if(controller.signal.aborted||epoch!==this.epoch||scope!==scopeKey(this.getScope()))throw cancelled();return value;
    }finally{this.controllers.delete(controller);}
  }
  reset(){this.epoch++;for(const controller of this.controllers)controller.abort();this.controllers.clear();this.scope=null;}
  dispose(){this.reset();}
}
