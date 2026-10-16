import {USER_TABLES,SHARED_TABLES,itemKey,millis,cloudItem,cloudProgress,recordIdentity,replaceRecord,librarySnapshot,cloudBootstrap} from './cloud-library-records.js';
import {CloudOutbox,cloudPreference} from './cloud-outbox.js';
import {markerSeriesBySlug} from './series-markers/registry.js';
import {isAdultItem} from './parental-classification.js';

const loadRuntime=()=>import('/assets/vendor/cloud-client.js');
const emptyRows=()=>Object.fromEntries(USER_TABLES.map(table=>[table,[]]));
const safeError=()=>new Error('Não foi possível sincronizar sua biblioteca. Seus dados locais continuam disponíveis.');
const accessError=()=>Object.assign(safeError(),{cloudAccessDenied:true});
const authFailure=(error,stage)=>Boolean(error?.cloudAuthFailure||stage.startsWith('auth_')&&([401,403].includes(Number(error?.status))||['refresh_token_not_found','refresh_token_already_used','invalid_refresh_token','session_not_found','bad_jwt','session_expired','refresh_token_expired','user_not_found'].includes(error?.code)));
const conflict={user_favorites:'user_id,provider,item_key',user_progress:'user_id,provider,item_key,episode_id',user_preferences:'user_id,provider,key',custom_collections:'user_id,provider,id'};
// Keep one GoTrueClient per SDK/project/user for this JS realm. Disposing Auth
// removes Supabase's internal token -> Realtime listener, so a disposed client
// must neither be reused nor replaced on every transient library retry.
const authClients=new WeakMap();
const authIdentity=scope=>JSON.stringify([scope.url,scope.userId]);
const serializeAuth=(entry,operation)=>{
  const pending=entry.pending.catch(()=>{}).then(operation);entry.pending=pending.catch(()=>{});return pending;
};
function reusableClient(createClient,scope,owner,fetch){
  let clients=authClients.get(createClient);if(!clients){clients=new Map();authClients.set(createClient,clients);}
  const identity=authIdentity(scope);let entry=clients.get(identity);
  if(entry&&(entry.publishableKey!==scope.publishableKey||entry.owner&&entry.owner!==owner))throw safeError();
  if(!entry){
    entry={identity,publishableKey:scope.publishableKey,pending:Promise.resolve(),revoked:false,owner:null,fetch};
    entry.client=createClient(scope.url,scope.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:`arkhen.cloud.${new URL(scope.url).host}.${scope.userId}`},global:{fetch:(...args)=>(entry.fetch||globalThis.fetch)(...args)}});
    clients.set(identity,entry);
  }
  entry.owner=owner;entry.fetch=fetch;return entry;
}

/** Supabase transport and TanStack Query cache; it never owns the local player. */
export class CloudLibrary {
  constructor({loadSDK=loadRuntime,onUpdate=()=>{},onStatus=()=>{},onSharedUpdate=()=>{},onDiagnostic=event=>globalThis.console?.warn?.('[arkhen.cloud]',event),now=Date.now,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer),fetch=(...args)=>globalThis.fetch(...args),pageTarget=globalThis.window,storage,canRemember=()=>true,onHistoryBlocked=()=>{}}={}){
    Object.assign(this,{loadSDK,onUpdate,onStatus,onSharedUpdate,onDiagnostic,now,schedule,cancel,fetch,pageTarget,canRemember,onHistoryBlocked});
    this.blockedProgressItems=new Set();
    this.epoch=0;this.connectRequest=0;this.client=null;this.authEntry=null;this.queryClient=null;this.scope=null;this.ready=false;this.listeners=new Set();this.rows=emptyRows();
    this.offlineScope=null;this.outbox=new CloudOutbox({storage});this.cleanupPending=Promise.resolve();
    this.outboxTimer=null;this.outboxAttempt=0;
    this.channel=null;this.authSubscription=null;this.queryUnsubscribe=null;this.progressQueue=new Map();this.progressTimer=null;this.writeControllers=new Set();this.revisions=new Map();this.optimisticRows=new Map();this.lastStamp=0;
    this.pagehide=()=>{void this.flushProgress({keepalive:true}).catch(()=>{});};
    this.online=()=>{if(this.ready){void this.load({force:true}).catch(()=>{});void this.flushProgress().then(()=>this.flushOutbox()).catch(()=>{});}};
    pageTarget?.addEventListener?.('pagehide',this.pagehide);pageTarget?.addEventListener?.('online',this.online);
    this.status={state:'local',message:'Biblioteca salva neste aparelho.'};
  }
  getStatus(){return {...this.status};}
  getConnectionFailure(){return this.connectionFailure?{...this.connectionFailure}:null;}
  #diagnostic(code,stage,status){try{this.onDiagnostic({code,stage,...(Number.isInteger(status)&&status>=100&&status<=599?{status}:{})});}catch{/* Diagnostics never alter authentication. */}}
  #notify(callback,value,stage){try{callback(value);}catch{this.#diagnostic('CLOUD_UI_CALLBACK_FAILED',stage);}}
  #status(state,message){this.status={state,message};this.#notify(this.onStatus,this.getStatus(),'status');}
  #libraryStatus(){const pending=this.outbox.entries().length;this.#status(pending?(this.status.state==='offline'?'offline':'syncing'):'synced',pending?'Algumas alterações locais aguardam sincronização.':'Sua biblioteca está sincronizada.');}
  subscribe(listener){this.listeners.add(listener);if(this.ready)this.#notify(listener,this.snapshot(),'subscriber');return()=>this.listeners.delete(listener);}
  snapshot(){
    if(!this.ready)return {ready:false,favorites:[],history:[],episodes:[],preferences:{},collections:[]};
    const rows=this.outbox.apply(this.rows);rows.user_progress=rows.user_progress.filter(row=>!this.#privateEntry(row.entry));
    return librarySnapshot(rows,{...this.scope,canRemember:item=>this.#rememberItem(item)});
  }
  #rememberItem(item){return Boolean(item)&&!isAdultItem(item)&&!this.blockedProgressItems.has(itemKey(item))&&this.canRemember(item);}
  #rememberProgress(entry){return Boolean(cloudProgress(entry,{canRemember:item=>this.#rememberItem(item)}));}
  #privateEntry(entry){return isAdultItem(entry)||isAdultItem(entry?.episode)||Boolean(entry?.item&&!this.#rememberItem(entry.item));}
  purgeHistory(){
    const rejected=row=>this.#privateEntry(row.entry);let removed=this.outbox.discard(({table,row})=>table==='user_progress'&&rejected(row));
    for(const [key,row]of this.progressQueue)if(rejected(row)){this.progressQueue.delete(key);removed++;}
    for(const [key,value]of this.optimisticRows)if(value.table==='user_progress'&&rejected(value.row))this.optimisticRows.delete(key);
    const before=this.rows.user_progress;this.rows.user_progress=before.filter(row=>!rejected(row));removed+=before.length-this.rows.user_progress.length;
    if(this.ready&&this.queryClient){const key=this.#key('user_progress'),cached=this.queryClient.getQueryData(key);if(cached?.some(rejected))this.queryClient.setQueryData(key,cached.filter(row=>!rejected(row)));}
    return removed;
  }
  #forgetProgress(item){
    if(!item)return;this.blockedProgressItems.add(itemKey(item));this.purgeHistory();this.#notify(this.onHistoryBlocked,item,'history_privacy');this.#libraryStatus();
  }
  #publish(){if(!this.ready)return;const snapshot=this.snapshot();this.#notify(this.onUpdate,snapshot,'update');for(const listener of this.listeners)this.#notify(listener,snapshot,'subscriber');}
  #current(epoch,client=this.client){return this.epoch===epoch&&this.client===client&&Boolean(this.scope);}
  #key(table,...suffix){return ['arkhen-cloud',this.scope.url,this.scope.provider,this.scope.userId,table,this.scope.providerKey,this.scope.scopeHash,...suffix];}
  #stamp(){this.lastStamp=Math.max(this.now(),this.lastStamp+1);return new Date(this.lastStamp).toISOString();}
  #outboxScope(scope){
    const previous=this.outbox.scope;
    if(scope&&previous&&scope.url===previous.url&&scope.provider===previous.provider&&scope.userId===previous.userId&&scope.libraryId===previous.libraryId)this.outbox.scope=scope;
    else this.outbox.setScope(scope);
  }
  async resume({libraryId,pending=false,code}={}){
    const scope=this.scope||this.offlineScope;
    // A missing backend bootstrap is not a sign-out. Only a client already
    // authorized for this exact library may recover its own rotated session.
    if(libraryId&&scope?.libraryId===libraryId&&this.authEntry&&!this.authEntry.revoked&&this.authEntry.identity===authIdentity(scope))return this.connect(scope);
    if(scope&&scope.libraryId!==libraryId){const request=this.connectRequest+1;await this.logout({flush:false});if(request!==this.connectRequest)return null;}
    if(!this.ready){
      const backendCode=typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:null;
      this.connectionFailure={code:pending?'CLOUD_BOOTSTRAP_PENDING':'CLOUD_BOOTSTRAP_UNAVAILABLE',stage:'bootstrap',authRecoveryRequired:false,...(backendCode?{backendCode}:{})};
      if(!pending&&backendCode)this.#diagnostic(backendCode,'bootstrap');
      this.#status(pending?'connecting':'offline',pending?'Preparando a sincronização da sua biblioteca…':'A sincronização está temporariamente indisponível. Sua biblioteca continua salva neste aparelho.');
    }
    return null;
  }
  async connect(value,{preferBootstrap=false}={}){
    this.connectionFailure=null;
    const valid=cloudBootstrap(value);
    if(!preferBootstrap&&this.ready&&valid&&valid.url===this.scope?.url&&valid.publishableKey===this.scope?.publishableKey&&valid.userId===this.scope?.userId&&valid.provider===this.scope?.provider&&valid.providerKey===this.scope?.providerKey&&valid.scopeHash===this.scope?.scopeHash)return this.load({force:true});
    const request=++this.connectRequest,sameAuth=valid&&this.authEntry?.identity===authIdentity(valid);
    await this.logout({flush:false,cancelConnect:false,revoke:!sameAuth});if(request!==this.connectRequest)return null;
    const scope=valid;if(!scope){this.#status('local','Sincronização na nuvem ainda não configurada.');return null;}
    this.offlineScope=scope;this.#outboxScope(scope);this.purgeHistory();
    const epoch=this.epoch;let stage='sdk';this.#status('connecting','Conectando sua biblioteca…');
    try{
      const {createClient,QueryClient}=await this.loadSDK();if(this.epoch!==epoch||request!==this.connectRequest)return null;
      const entry=reusableClient(createClient,scope,this,(input,options)=>this.#fetchWithDeadline(input,options)),client=entry.client;this.authEntry=entry;
      this.client=client;this.scope=scope;this.queryClient=new QueryClient({defaultOptions:{queries:{staleTime:30000,gcTime:300000,retry:1,refetchOnWindowFocus:false},mutations:{retry:0,gcTime:0}}});this.queryClient.mount();
      // The browser SDK may already have rotated its refresh token. A cached
      // backend bootstrap must not replace that newer session on page reload.
      const current=()=>request===this.connectRequest&&this.#current(epoch,client);
      const authorized=await serializeAuth(entry,async()=>{
        if(!current())return null;
        stage='auth_session';const persisted=preferBootstrap||entry.revoked?{data:{session:null}}:await client.auth.getSession();if(!current())return null;if(persisted.error)throw persisted.error;
        const previous=persisted.data?.session;if(previous?.user?.id&&previous.user.id!==scope.userId)throw accessError();
        const reusable=previous?.user?.id===scope.userId&&previous.access_token&&previous.refresh_token;
        stage='auth_set_session';const result=reusable?persisted:await client.auth.setSession(scope.session);if(!current())return null;if(result.error)throw result.error;
        stage='auth_user';const verified=await client.auth.getUser();if(!current())return null;if(verified.error)throw verified.error;if(verified.data?.user?.id!==scope.userId)throw accessError();
        entry.revoked=false;return result;
      });
      if(!authorized||!current())return null;
      stage='profile';const profile=await client.from('profiles').select('id,provider,provider_key,scope_hash,status,access_expires_at,last_validated_at').eq('id',scope.userId).maybeSingle();
      if(!current())return null;
      if(profile.error)throw Object.assign(safeError(),{status:profile.status||profile.error.status,cloudAuthFailure:Number(profile.status||profile.error.status)===401});
      if(!this.#profileActive(profile.data)||profile.data.provider!==scope.provider||profile.data.provider_key!==scope.providerKey||profile.data.scope_hash!==scope.scopeHash)throw accessError();
      this.accessToken=authorized.data?.session?.access_token||scope.session.access_token;
      this.authSubscription=client.auth.onAuthStateChange((event,session)=>{
        if(!this.#current(epoch,client))return;
        if(session?.user?.id===scope.userId)this.accessToken=session.access_token;
        else if(event==='SIGNED_OUT'||session?.user?.id&&session.user.id!==scope.userId){this.accessToken=null;this.ready=false;queueMicrotask(()=>{if(this.#current(epoch,client))void this.logout({flush:false});});}
      }).data?.subscription;
      this.queryUnsubscribe=this.queryClient.getQueryCache().subscribe(event=>{
        if(!this.#current(epoch,client)||!this.ready||event.type!=='updated'||event.query?.state?.status!=='success')return;
        const table=event.query.queryKey?.[4];if(!USER_TABLES.includes(table))return;
        this.rows[table]=event.query.state.data;this.#publish();
      });
      stage='library';const snapshot=await this.load({force:true});if(!this.#current(epoch,client))return null;if(!snapshot)throw Object.assign(safeError(),{cloudAuthFailure:this.connectionFailure?.authRecoveryRequired,status:this.connectionFailure?.status});
      this.#subscribeRealtime(epoch,client);await this.flushOutbox();if(!this.#current(epoch,client))return null;this.#libraryStatus();return this.snapshot();
    }catch(error){
      // A temporary data/API outage must not revoke the still-valid Auth
      // bootstrap cached by the backend. Detach data/query state while keeping
      // the same Auth client and its possibly rotated session for recovery.
      const revoke=error?.cloudAccessDenied===true,authRecoveryRequired=!revoke&&authFailure(error,stage),status=Number(error?.status);
      if(this.epoch===epoch&&request===this.connectRequest){this.connectionFailure={code:revoke?'CLOUD_ACCESS_DENIED':authRecoveryRequired?'CLOUD_AUTH_SESSION_REJECTED':'CLOUD_CONNECTION_FAILED',stage,authRecoveryRequired,...(Number.isInteger(status)&&status>=100&&status<=599?{status}:{})};this.#diagnostic(this.connectionFailure.code,stage,status);await this.logout({flush:false,preserveOffline:scope,revoke,cancelConnect:false});if(request===this.connectRequest)this.#status(revoke?'restricted':'offline','Não foi possível conectar à nuvem. Sua biblioteca local continua disponível.');}
      return null;
    }
  }
  async #fetchWithDeadline(input,options={}){
    const controller=new AbortController(),abort=()=>controller.abort(),timer=globalThis.setTimeout(abort,12000);
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    try{return await this.fetch(input,{...options,signal:controller.signal});}
    finally{globalThis.clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
  }
  #profileActive(profile){return profile?.id===this.scope?.userId&&profile.status==='active'&&(!profile.access_expires_at||millis(profile.access_expires_at)>this.now())&&millis(profile.last_validated_at)>this.now()-86400000;}
  async #readTable(table,signal){
    const {client,scope}=this,rows=[];
    for(let offset=0;offset<10000;offset+=1000){
      let query=client.from(table).select('*').eq('user_id',scope.userId).eq('provider',scope.provider).order('updated_at',{ascending:true}).range(offset,offset+999);
      if(signal)query=query.abortSignal(signal);
      const result=await query;if(result.error)throw Object.assign(safeError(),{status:result.status||result.error.status,cloudAuthFailure:Number(result.status||result.error.status)===401});
      const page=(result.data||[]).filter(row=>row.user_id===scope.userId&&row.provider===scope.provider);rows.push(...page);
      if((result.data||[]).length<1000){let merged=rows;for(const value of this.optimisticRows.values())if(value.table===table)merged=replaceRecord(merged,value.row,table);return table==='user_progress'?merged.filter(row=>!this.#privateEntry(row.entry)):merged;}
    }
    throw safeError();
  }
  async load({force=false}={}){
    if(!this.client||!this.scope||!this.queryClient)return null;
    const epoch=this.epoch,client=this.client,queryClient=this.queryClient;
    try{
      const rows=await Promise.all(USER_TABLES.map(table=>queryClient.fetchQuery({queryKey:this.#key(table),gcTime:Infinity,staleTime:force?0:30000,queryFn:({signal})=>this.#readTable(table,signal)})));
      if(!this.#current(epoch,client))return null;
      USER_TABLES.forEach((table,index)=>{this.rows[table]=rows[index];});this.ready=true;this.#publish();
      this.#libraryStatus();return this.snapshot();
    }catch(error){if(this.#current(epoch,client)){this.connectionFailure={code:error?.cloudAuthFailure?'CLOUD_AUTH_SESSION_REJECTED':'CLOUD_LIBRARY_READ_FAILED',stage:'library',authRecoveryRequired:error?.cloudAuthFailure===true,...(error?.status?{status:error.status}:{})};this.#diagnostic(this.connectionFailure.code,'library',error?.status);this.#status('offline','Sincronização temporariamente indisponível. Seus dados locais foram mantidos.');}return null;}
  }
  #subscribeRealtime(epoch,client){
    const scope=this.scope;
    let channel=client.channel(`arkhen-library:${scope.provider}:${scope.userId}`);
    for(const table of USER_TABLES)for(const event of ['INSERT','UPDATE'])channel=channel.on('postgres_changes',{event,schema:'public',table,filter:`user_id=eq.${scope.userId}`},payload=>{
      if(!this.#current(epoch,client))return;
      const row=payload.new||payload.old;if(row?.provider&&row.provider!==scope.provider)return;
      void this.queryClient.invalidateQueries({queryKey:this.#key(table),refetchType:'all'}).catch(()=>{});
    });
    for(const table of SHARED_TABLES)for(const event of ['INSERT','UPDATE'])channel=channel.on('postgres_changes',{event,schema:'public',table:table==='provider_catalog_cache'?'catalog_visible_generations':table,...(table==='marker_cache_versions'?{filter:'name=eq.global'}:{filter:`provider_key=eq.${scope.providerKey}`})},payload=>{
      if(!this.#current(epoch,client))return;
      const row=payload?.new||payload?.old;
      if(row?.scope_hash&&row.scope_hash!==scope.scopeHash||row?.provider_key&&row.provider_key!==scope.providerKey)return;
      if(table==='marker_cache_versions'){
        for(const cached of ['episode_skip_markers','series_marker_identities','series_marker_coverage'])void this.queryClient.invalidateQueries({queryKey:this.#key(cached),refetchType:'all'}).catch(()=>{});
        this.#notify(this.onSharedUpdate,{table:'episode_skip_markers'},'shared_update');return;
      }
      const type=['live','movies','series'].includes(row?.media_type)?row.media_type:undefined;
      if(table!=='provider_catalog_cache'||type)void this.queryClient.invalidateQueries({queryKey:this.#key(table,...(type?[type]:[])),refetchType:'all'}).catch(()=>{});
      this.#notify(this.onSharedUpdate,{table,...(type?{type}:{}),...(row?.updated_at?{revision:row.updated_at}:{})},'shared_update');
    });
    channel=channel.on('postgres_changes',{event:'UPDATE',schema:'public',table:'profiles',filter:`id=eq.${scope.userId}`},payload=>{
      if(!this.#current(epoch,client)||payload.new?.id!==scope.userId)return;
      if(!this.#profileActive(payload.new)||payload.new.provider!==scope.provider||payload.new.provider_key!==scope.providerKey||payload.new.scope_hash!==scope.scopeHash)void this.logout({flush:false}).then(()=>{if(!this.scope)this.#status('restricted','O acesso à biblioteca precisa ser validado novamente. Entre na sua conta.');});
    });
    this.channel=channel.subscribe(status=>{
      if(!this.#current(epoch,client))return;
      if(status==='SUBSCRIBED'){
        // Rejoining a WebSocket does not replay changes missed while offline.
        // Also close the gap between the initial SELECT and subscription join.
        void this.flushProgress().then(()=>this.flushOutbox()).then(()=>this.load({force:true})).catch(()=>{});
      }else if(['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status))this.#status('offline','Atualização em tempo real indisponível. Seus dados locais foram mantidos.');
    });
  }
  #row(table,value){
    const scope=this.scope||this.offlineScope;if(!scope)return null;
    return {user_id:scope.userId,provider:scope.provider,...value,updated_at:this.#stamp()};
  }
  #retryOutbox(epoch=this.epoch,client=this.client){
    if(!this.#current(epoch,client)||!this.outbox.entries().length||this.outboxTimer!==null)return;
    this.outboxTimer=this.schedule(()=>{
      this.outboxTimer=null;if(!this.#current(epoch,client))return;
      void this.flushOutbox().then(saved=>{if(this.#current(epoch,client)&&!saved)this.#retryOutbox(epoch,client);}).catch(()=>this.#retryOutbox(epoch,client));
    },Math.min(60000,5000*2**Math.min(this.outboxAttempt++,4)));
  }
  async #write(table,row){
    if(table==='user_progress'&&this.#privateEntry(row?.entry)){this.purgeHistory();return true;}
    if(!row||!this.outbox.put(table,row))return false;
    if(!this.ready)return true;
    this.#status('syncing','Salvando alterações da sua biblioteca…');
    const epoch=this.epoch,client=this.client,queryClient=this.queryClient,key=this.#key(table),revisionKey=`${table}:${recordIdentity(table,row)}`,revision=row.updated_at;
    this.revisions.set(revisionKey,revision);
    const mutation=queryClient.getMutationCache().build(queryClient,{
      mutationKey:[...key,recordIdentity(table,row)],
      mutationFn:async()=>{
        if(!this.#current(epoch,client))return false;
        if(table==='user_progress'&&this.#privateEntry(row.entry)){this.purgeHistory();return row;}
        const controller=new AbortController();this.writeControllers.add(controller);
        try{
          const result=await client.from(table).upsert(row,{onConflict:conflict[table]}).select('*').abortSignal(controller.signal);
          if(result.error){if(table==='user_progress'&&result.error.code==='P0001'&&String(result.error.message).includes('ARKHEN_ADULT_PROGRESS_DISABLED'))throw Object.assign(safeError(),{adultProgressBlocked:true});throw safeError();}return result.data?.[0]||row;
        }finally{this.writeControllers.delete(controller);}
      },
      onMutate:async()=>{
        await queryClient.cancelQueries({queryKey:key});if(!this.#current(epoch,client)||this.revisions.get(revisionKey)!==revision)return null;
        if(table==='user_progress'&&this.#privateEntry(row.entry))return null;
        const previous=queryClient.getQueryData(key)||[],old=previous.find(entry=>recordIdentity(table,entry)===recordIdentity(table,row));
        this.optimisticRows.set(revisionKey,{table,row});queryClient.setQueryData(key,replaceRecord(previous,row,table));return {old};
      },
      onError:(error,__,previous)=>{
        if(!this.#current(epoch,client))return;
        if(error?.adultProgressBlocked){this.#forgetProgress(row.entry?.item);return;}
        if(table==='user_progress'&&this.#privateEntry(row.entry)){this.purgeHistory();this.#libraryStatus();return;}
        if(this.revisions.get(revisionKey)===revision&&previous){
          this.optimisticRows.delete(revisionKey);
          const remaining=(queryClient.getQueryData(key)||[]).filter(entry=>recordIdentity(table,entry)!==recordIdentity(table,row));
          queryClient.setQueryData(key,previous.old?[...remaining,previous.old]:remaining);
        }
        this.#status('offline','A alteração continua salva neste aparelho e aguarda sincronização.');
        this.#retryOutbox(epoch,client);
      },
      onSuccess:stored=>{if(this.#current(epoch,client)&&stored){
        if(table==='user_progress'&&(this.#privateEntry(row.entry)||this.#privateEntry(stored.entry))){this.outbox.acknowledge(table,row);this.purgeHistory();this.#libraryStatus();return;}
        this.outbox.acknowledge(table,row);if(this.revisions.get(revisionKey)===revision)queryClient.setQueryData(key,replaceRecord(queryClient.getQueryData(key)||[],stored,table));
        if(!this.outbox.entries().length){if(this.outboxTimer!==null)this.cancel(this.outboxTimer);this.outboxTimer=null;this.outboxAttempt=0;this.#status('synced','Sua biblioteca está sincronizada.');}
      }},
      onSettled:()=>{if(this.#current(epoch,client)){if(this.revisions.get(revisionKey)===revision)this.optimisticRows.delete(revisionKey);void queryClient.invalidateQueries({queryKey:key,refetchType:'all'}).catch(()=>{});}}
    });
    try{return Boolean(await mutation.execute(row));}catch(error){return error?.adultProgressBlocked===true||table==='user_progress'&&this.#privateEntry(row.entry);}
  }
  saveFavorite(value,active=true){const item=cloudItem(value),scope=this.scope||this.offlineScope;if(!item||!scope||value.libraryId&&scope.libraryId&&value.libraryId!==scope.libraryId)return Promise.resolve(false);return this.#write('user_favorites',this.#row('user_favorites',{item_key:itemKey(item),item,deleted_at:active?null:new Date(this.now()).toISOString()}));}
  saveProgress(value,{force=false}={}){
    const entry=this.#rememberProgress(value)?cloudProgress(value,{canRemember:this.canRemember}):null,scope=this.scope||this.offlineScope;if(!entry||!scope||value.libraryId&&scope.libraryId&&value.libraryId!==scope.libraryId)return Promise.resolve(false);
    const row=this.#row('user_progress',{item_key:itemKey(entry.item),episode_id:entry.episode?.id||'',entry,deleted_at:null});
    this.outbox.put('user_progress',row);if(!this.ready)return Promise.resolve(true);
    this.#status('syncing','Salvando seu progresso…');
    this.progressQueue.set(recordIdentity('user_progress',row),row);
    if(force)return this.flushProgress();
    if(this.progressTimer===null)this.progressTimer=this.schedule(()=>{this.progressTimer=null;void this.flushProgress().catch(()=>{});},5000);
    return Promise.resolve(true);
  }
  async flushProgress({keepalive=false}={}){
    this.purgeHistory();
    if(this.progressTimer!==null)this.cancel(this.progressTimer);this.progressTimer=null;
    if(!this.ready||!this.progressQueue.size)return true;
    const epoch=this.epoch,client=this.client,entries=[...this.progressQueue.entries()];this.progressQueue.clear();
    if(keepalive&&this.fetch&&this.accessToken){
      try{
        const response=await this.fetch(`${this.scope.url}/rest/v1/user_progress?on_conflict=${encodeURIComponent(conflict.user_progress)}`,{method:'POST',keepalive:true,
          headers:{apikey:this.scope.publishableKey,Authorization:`Bearer ${this.accessToken}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(entries.map(([,row])=>row))});
        if(response.ok){if(this.#current(epoch,client)){for(const [,row]of entries)this.outbox.acknowledge('user_progress',row);this.#libraryStatus();}return true;}
        const error=await response.json().catch(()=>null);
        if(this.#current(epoch,client)&&error?.code==='P0001'&&String(error.message).includes('ARKHEN_ADULT_PROGRESS_DISABLED'))return (await Promise.all(entries.map(([,row])=>this.#write('user_progress',row)))).every(Boolean);
      }catch{/* Local progress remains the fallback when the tab loses connectivity. */}
      if(this.#current(epoch,client))for(const [key,row]of entries)if(!this.#privateEntry(row.entry)&&!this.progressQueue.has(key))this.progressQueue.set(key,row);return false;
    }
    const result=await Promise.all(entries.map(async([key,row])=>{const saved=await this.#write('user_progress',row);if(!saved&&this.#current(epoch,client)&&!this.progressQueue.has(key))this.progressQueue.set(key,row);return saved;}));
    return result.every(Boolean);
  }
  savePreference(key,value){
    const data=cloudPreference(key,value);return data!==null?this.#write('user_preferences',this.#row('user_preferences',{key,value:data,deleted_at:null})):Promise.resolve(false);
  }
  saveCollection(value){
    if(!value||typeof value.id!=='string'||!/^[\w-]{1,160}$/.test(value.id)||typeof value.name!=='string'||!value.name.trim()||!['live','movies','series'].includes(value.collection_type))return Promise.resolve(false);
    return this.#write('custom_collections',this.#row('custom_collections',{id:value.id,name:value.name.slice(0,80),collection_type:value.collection_type,item_keys:[...new Set((Array.isArray(value.item_keys)?value.item_keys:[]).filter(key=>typeof key==='string'&&/^(live|movie|series):[\w-]{1,160}$/.test(key)))].slice(0,1000),deleted_at:millis(value.deleted_at)?new Date(millis(value.deleted_at)).toISOString():null}));
  }
  removeCollection(value){return this.saveCollection({...value,name:value?.name||'Categoria removida',deleted_at:new Date(this.now()).toISOString()});}
  async flushOutbox(){this.purgeHistory();if(!this.ready)return false;const entries=this.outbox.entries();const results=[];for(const {table,row}of entries){if(!this.ready)return false;results.push(await this.#write(table,row));}return results.every(Boolean);}
  async syncLocal({libraryId,favoritesMap,historyMap,episodeEntries=[]}={}){
    if(!this.ready||!libraryId||libraryId!==this.scope.libraryId)return false;
    const epoch=this.epoch,client=this.client;
    const favorites=new Map(this.snapshot().favoriteRecords.map(row=>[row.item_key,row]));
    for(const value of favoritesMap?.values?.()||[]){if(!this.#current(epoch,client))return false;if(value.libraryId&&value.libraryId!==libraryId)continue;const item=cloudItem(value);if(!item)continue;const remote=favorites.get(itemKey(item));if(remote&&millis(remote.updated_at)>=millis(value.savedAt))continue;await this.saveFavorite(item,true);}
    const progress=new Map(this.snapshot().progressRecords.map(row=>[recordIdentity('user_progress',row),row]));
    const candidates=new Map();
    for(const value of [...(historyMap?.values?.()||[]),...episodeEntries]){
      if(value.libraryId&&value.libraryId!==libraryId)continue;const entry=this.#rememberProgress(value)?cloudProgress(value,{canRemember:this.canRemember}):null;if(!entry)continue;
      const key=JSON.stringify([itemKey(entry.item),entry.episode?.id||'']),old=candidates.get(key);if(!old||old.updated<entry.updated)candidates.set(key,entry);
    }
    for(const [key,entry]of candidates){
      if(!this.#current(epoch,client))return false;
      const remote=progress.get(key);if(remote&&millis(remote.updated_at)>=entry.updated)continue;
      await this.saveProgress({...entry,libraryId},{force:true});
    }
    return true;
  }
  hydrate({favoritesMap,historyMap,episodeProgress}={}){
    if(!this.ready)return null;const snapshot=this.snapshot();
    if(favoritesMap)for(const row of snapshot.favoriteRecords){const local=favoritesMap.get(row.item_key);if(local&&millis(local.savedAt)>millis(row.updated_at))continue;if(row.deleted_at)favoritesMap.delete(row.item_key);else{const item=cloudItem(row.item);if(item&&itemKey(item)===row.item_key)favoritesMap.set(row.item_key,{...item,savedAt:millis(row.updated_at),...(this.scope.libraryId?{libraryId:this.scope.libraryId}:{})});}}
    if(historyMap){
      for(const [key,entry]of historyMap)if(!this.#rememberProgress(entry)){historyMap.delete(key);episodeProgress?.purge?.(entry.item);}
      for(const row of snapshot.progressRecords.filter(row=>row.deleted_at)){const local=historyMap.get(row.item_key);if(local&&(local.episode?.id||'')===(row.episode_id||'')&&millis(local.updated)<=millis(row.updated_at))historyMap.delete(row.item_key);}
      for(const entry of snapshot.history){const key=itemKey(entry.item),local=historyMap.get(key);if(!local||millis(local.updated)<=entry.updated)historyMap.set(key,entry);}
    }
    if(episodeProgress)for(const entry of snapshot.episodes){const existing=episodeProgress.read(entry.item,entry.episode);if(!existing||millis(existing.updated)<=entry.updated)episodeProgress.save(entry);}
    return snapshot;
  }
  async #shared(table,filters,keyParts,{complete=false}={}){
    if(!this.ready||!this.scope?.providerKey||!this.scope?.scopeHash)return null;
    const epoch=this.epoch,client=this.client;
    try{
      const record=await this.queryClient.fetchQuery({queryKey:this.#key(table,...keyParts),staleTime:30000,queryFn:async({signal})=>{
        let query=client.from(table).select('*').eq('provider_key',this.scope.providerKey).eq('scope_hash',this.scope.scopeHash);
        for(const [key,value]of Object.entries(filters))query=query.eq(key,value);
        const result=await query.abortSignal(signal).maybeSingle();if(result.error)throw safeError();return result.data;
      }});
      return this.#current(epoch,client)&&record&&millis(record.expires_at)>this.now()&&(!complete||record.is_complete===true)?record.payload:null;
    }catch{return null;}
  }
  cachedCatalog(type){return ['live','movies','series'].includes(type)?this.#shared('provider_catalog_cache',{media_type:type},[type],{complete:true}):Promise.resolve(null);}
  epg(channelId){return /^\d{1,12}$/.test(String(channelId))?this.#shared('provider_epg_cache',{channel_id:String(channelId)},[String(channelId)]):Promise.resolve(null);}
  games(date,timeZone){return /^\d{4}-\d{2}-\d{2}$/.test(date||'')&&typeof timeZone==='string'&&timeZone.length<=80?this.#shared('provider_games_cache',{game_date:date,time_zone:timeZone},[date,timeZone]):Promise.resolve(null);}
  async markerSeriesIdentity(item){
    if(!this.ready||item?.kind!=='series'||!/^\d{1,12}$/.test(String(item.id)))return null;
    const epoch=this.epoch,client=this.client,scope=this.scope;
    try{
      const row=await this.queryClient.fetchQuery({queryKey:this.#key('series_marker_identities',String(item.id)),staleTime:300000,queryFn:async({signal})=>{
        const result=await client.from('series_marker_identities').select('provider_key,scope_hash,media_id,catalog_name,series_slug,imdb_id,tmdb_id,status').eq('provider_key',scope.providerKey).eq('scope_hash',scope.scopeHash).eq('media_id',String(item.id)).eq('status','resolved').abortSignal(signal).maybeSingle();
        if(result.error)throw safeError();return result.data;
      }});
      if(!this.#current(epoch,client)||!row)return null;
      const {markerSeriesFromIdentity}=await import('./series-markers/registry.js');return markerSeriesFromIdentity(row,item);
    }catch{return null;}
  }
  async markerManifest(seriesSlug,{season,episode}={}){
    let series=markerSeriesBySlug(seriesSlug);if(!this.ready||!series&&!/^imdb-tt\d{6,10}$/.test(seriesSlug||''))return null;
    const epoch=this.epoch,client=this.client;
    try{
      const specific=Number.isSafeInteger(season)&&season>=0&&Number.isSafeInteger(episode)&&episode>0;
      const rows=await this.queryClient.fetchQuery({queryKey:this.#key('episode_skip_markers',seriesSlug,...(specific?[season,episode]:[])),staleTime:300000,queryFn:async({signal})=>{
        const rows=[];for(let offset=0;offset<2000;offset+=1000){
          let query=client.from('episode_skip_markers').select('*').eq('series_slug',seriesSlug).eq('is_active',true);if(specific)query=query.eq('season',season).eq('episode',episode);
          const result=await query.order('season').order('episode').range(offset,offset+999).abortSignal(signal);
          if(result.error)throw safeError();rows.push(...(result.data||[]));if((result.data||[]).length<1000)break;
        }return rows;
      }});
      if(!this.#current(epoch,client))return null;
      if(!series){const imdbId=seriesSlug.slice(5),candidate=rows.find(row=>row.imdb_id===imdbId);series={slug:seriesSlug,title:imdbId,imdbId,tmdbId:candidate?.tmdb_id==null?null:Number(candidate.tmdb_id)};}
      let episodeEvidence=null;
      if(specific){episodeEvidence=await this.queryClient.fetchQuery({queryKey:this.#key('series_marker_coverage',series.imdbId,season,episode),staleTime:300000,queryFn:async({signal})=>{
        const result=await client.from('series_marker_coverage').select('imdb_id,season,episode,status,evidence,updated_at').eq('imdb_id',series.imdbId).eq('season',season).eq('episode',episode).abortSignal(signal).maybeSingle();
        if(result.error)return null;return result.data;
      }});}
      if(!this.#current(epoch,client))return null;
      const compatible=rows.filter(row=>(row.tmdb_id==null||series.tmdbId==null||Number(row.tmdb_id)===series.tmdbId)&&(row.imdb_id==null||row.imdb_id===series.imdbId));if(!compatible.length&&!episodeEvidence)return null;
      return {schemaVersion:1,dataVersion:compatible[0]?.data_version||'supabase',series:{slug:series.slug,title:series.title,tmdbId:series.tmdbId,imdbId:series.imdbId},episodeEvidence,records:compatible.map(row=>({season:row.season,episode:row.episode,edition:{id:row.edition_id,durationSeconds:Number(row.duration_seconds),toleranceSeconds:Number(row.tolerance_seconds),...(/^[a-f0-9]{16}$/.test(row.provenance?.edition?.sourceFingerprint||'')?{sourceFingerprint:row.provenance.edition.sourceFingerprint}:{})},verification:{...(row.provenance?.verification||{}),status:row.verification},markers:row.markers,sources:row.provenance?.sources||[]}))};
    }catch{return null;}
  }
  async logout({flush=true,cancelConnect=true,preserveOffline=null,revoke=true}={}){
    if(cancelConnect)++this.connectRequest;
    const request=this.connectRequest,startingEpoch=this.epoch,startingClient=this.client;
    if(flush){await this.flushProgress();await this.flushOutbox();}
    if(request!==this.connectRequest||startingEpoch!==this.epoch||startingClient!==this.client)return this.cleanupPending;
    ++this.epoch;const entry=this.authEntry,client=this.client||entry?.client,offlineScope=preserveOffline||(!revoke?(this.scope||this.offlineScope):null);if(revoke&&entry){entry.revoked=true;this.authEntry=null;}this.ready=false;this.scope=null;this.client=null;this.accessToken=null;this.blockedProgressItems.clear();
    if(this.outboxTimer!==null)this.cancel(this.outboxTimer);this.outboxTimer=null;this.outboxAttempt=0;
    if(this.progressTimer!==null)this.cancel(this.progressTimer);this.progressTimer=null;this.progressQueue.clear();
    for(const controller of this.writeControllers)controller.abort();this.writeControllers.clear();
    this.authSubscription?.unsubscribe();this.authSubscription=null;this.queryUnsubscribe?.();this.queryUnsubscribe=null;
    const queryClient=this.queryClient;this.queryClient=null;if(queryClient){void queryClient.cancelQueries();queryClient.clear();queryClient.unmount();}
    const channel=this.channel;this.channel=null;this.rows=emptyRows();this.revisions.clear();this.optimisticRows.clear();this.offlineScope=offlineScope;this.#outboxScope(offlineScope);this.#status('local','Biblioteca salva neste aparelho.');
    if(client)this.cleanupPending=this.cleanupPending.catch(()=>{}).then(async()=>{
      if(channel)await client.removeChannel(channel).catch(()=>{});
      if(entry)await serializeAuth(entry,async()=>{
        try{if(revoke)await client.auth.signOut({scope:'local'}).catch(()=>{});}
        finally{if(revoke&&entry.owner===this){entry.owner=null;entry.fetch=null;}}
      });
      else if(revoke)await client.auth.signOut({scope:'local'}).catch(()=>{});
    });
    await this.cleanupPending;
  }
  async dispose(){await this.logout();this.pageTarget?.removeEventListener?.('pagehide',this.pagehide);this.pageTarget?.removeEventListener?.('online',this.online);this.listeners.clear();}
}
