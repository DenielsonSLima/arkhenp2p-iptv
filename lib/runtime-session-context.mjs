import {AsyncLocalStorage} from 'node:async_hooks';

const contexts=new AsyncLocalStorage();
export const runtimeSessionContext=()=>contexts.getStore()||null;
export const withRuntimeSession=(context,operation)=>contexts.run(context,operation);
