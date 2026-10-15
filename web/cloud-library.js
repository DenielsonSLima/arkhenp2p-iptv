import {USER_TABLES,SHARED_TABLES,itemKey,millis,cloudItem,cloudProgress,recordIdentity,replaceRecord,librarySnapshot,cloudBootstrap} from './cloud-library-records.js';
import {CloudOutbox,cloudPreference} from './cloud-outbox.js';
import {markerSeriesBySlug} from './series-markers/registry.js';

const loadRuntime=()=>import('/assets/vendor/cloud-client.js');
const emptyRows=()=>Object.fromEntries(USER_TABLES.map(table=>[table,[]]));
const safeError=()=>new Error('Não foi possível sincronizar sua biblioteca. Seus dados locais continuam disponíveis.');
const accessError=()=>Object.assign(safeError(),{cloudAccessDenied:true});
const conflict={user_favorites:'user_id,provider,item_key',user_progress:'user_id,provider,item_key,episode_id',user_preferences:'user_id,provider,key',custom_collections:'user_id,provider,id'};

/** Supabase transport and TanStack Query cache; it never owns the local player. */
export class CloudLibrary {
  constructor({loadSDK=loadRuntime,onUpdate=()=>{},onStatus=()=>{},onSharedUpdate=()=>{},now=Date.now,
    schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer),fetch=(...args)=>globalThis.fetch(...args),pageTarget=globalThis.window,storage}={}){
    Object.assign(this,{loadSDK,onUpdate,onStatus,onSharedUpdate,now,schedule,cancel,fetch,pageTarget});
    this.epoch=0;this.connectRequest=0;this.client=null;this.queryClient=null;this.scope=null;this.ready=false;this.listeners=new Set();this.rows=emptyRows();
    this.offlineScope=null;this.outbox=new CloudOutbox({storage});this.cleanupPending=Promise.resolve();
    this.channel=null;this.authSubscription=null;this.queryUnsubscribe=null;this.progressQueue=new Map();this.progressTimer=null;this.writeControllers=new Set();this.revisions=new Map();this.optimisticRows=new Map();this.lastStamp=0;
    this.pagehide=()=>{void this.flushProgress({keepalive:true}).catch(()=>{});};
    this.online=()=>{if(this.ready){void this.load({force:true}).catch(()=>{});void this.flushProgress().then(()=>this.flushOutbox()).catch(()=>{});}};
    pageTarget?.addEventListener?.('pagehide',this.pagehide);pageTarget?.addEventListener?.('online',this.online);
    this.status={state:'local',message:'Biblioteca salva neste aparelho.'};
  }
  getStatus(){return {...this.status};}
  #status(state,message){this.status={state,message};this.onStatus(this.getStatus());}
  subscribe(listener){this.listeners.add(listener);if(this.ready)listener(this.snapshot());return()=>this.listeners.delete(listener);}
  snapshot(){return this.ready?librarySnapshot(this.outbox.apply(this.rows),this.scope):{ready:false,favorites:[],history:[],episodes:[],preferences:{},collections:[]};}
  #publish(){if(!this.ready)return;const snapshot=this.snapshot();this.onUpdate(snapshot);for(const listener of this.listeners)listener(snapshot);}
  #current(epoch,client=this.client){return this.epoch===epoch&&this.client===client&&Boolean(this.scope);}
  #key(table,...suffix){return ['arkhen-cloud',this.scope.url,this.scope.provider,this.scope.userId,table,this.scope.providerKey,this.scope.scopeHash,...suffix];}
  #stamp(){this.lastStamp=Math.max(this.now(),this.lastStamp+1);return new Date(this.lastStamp).toISOString();}
  async connect(value){
    const valid=cloudBootstrap(value);
    if(this.ready&&valid&&valid.url===this.scope?.url&&valid.userId===this.scope?.userId&&valid.provider===this.scope?.provider&&valid.providerKey===this.scope?.providerKey&&valid.scopeHash===this.scope?.scopeHash)return this.load({force:true});
    const request=++this.connectRequest;await this.logout({flush:false,cancelConnect:false});if(request!==this.connectRequest)return null;
    const scope=valid;if(!scope){this.#status('local','Sincronização na nuvem ainda não configurada.');return null;}
    this.offlineScope=scope;this.outbox.setScope(scope);
    const epoch=this.epoch;this.#status('connecting','Conectando sua biblioteca…');
    try{
      const {createClient,QueryClient}=await this.loadSDK();if(this.epoch!==epoch)return null;
      const client=createClient(scope.url,scope.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:`arkhen.cloud.${new URL(scope.url).hostname}.${scope.userId}`},global:{fetch:(input,options)=>this.#fetchWithDeadline(input,options)}});
      this.client=client;this.scope=scope;this.queryClient=new QueryClient({defaultOptions:{queries:{staleTime:30000,gcTime:300000,retry:1,refetchOnWindowFocus:false},mutations:{retry:0,gcTime:0}}});this.queryClient.mount();
      // The browser SDK may already have rotated its refresh token. A cached
      // backend bootstrap must not replace that newer session on page reload.
      const persisted=await client.auth.getSession();
      const previous=persisted.data?.session;
      const credentials=previous?.user?.id===scope.userId&&previous.access_token&&previous.refresh_token?previous:scope.session;
      const authorized=await client.auth.setSession(credentials);if(authorized.error)throw authorized.error;
      const verified=await client.auth.getUser();if(verified.error)throw verified.error;if(verified.data?.user?.id!==scope.userId)throw accessError();
      if(!this.#current(epoch,client))return null;
      const profile=await client.from('profiles').select('id,provider,provider_key,scope_hash,status,access_expires_at,last_validated_at').eq('id',scope.userId).maybeSingle();
      if(profile.error)throw profile.error;
      if(!this.#profileActive(profile.data)||profile.data.provider!==scope.provider||profile.data.provider_key!==scope.providerKey||profile.data.scope_hash!==scope.scopeHash)throw accessError();
      this.accessToken=authorized.data?.session?.access_token||scope.session.access_token;
      this.authSubscription=client.auth.onAuthStateChange((event,session)=>{
        if(!this.#current(epoch,client))return;
        if(session?.user?.id===scope.userId)this.accessToken=session.access_token;
        else if(event==='SIGNED_OUT')queueMicrotask(()=>{if(this.#current(epoch,client))void this.logout({flush:false});});
      }).data?.subscription;
      this.queryUnsubscribe=this.queryClient.getQueryCache().subscribe(event=>{
        if(!this.#current(epoch,client)||!this.ready||event.type!=='updated'||event.query?.state?.status!=='success')return;
        const table=event.query.queryKey?.[4];if(!USER_TABLES.includes(table))return;
        this.rows[table]=event.query.state.data;this.#publish();
      });
      const snapshot=await this.load({force:true});if(!this.#current(epoch,client))return null;if(!snapshot)throw safeError();
      this.#subscribeRealtime(epoch,client);await this.flushOutbox();if(!this.#current(epoch,client))return null;this.#status(this.outbox.entries().length?'offline':'synced',this.outbox.entries().length?'Algumas alterações locais aguardam sincronização.':'Sua biblioteca está sincronizada.');return this.snapshot();
    }catch(error){
      // A temporary data/API outage must not revoke the still-valid Auth
      // bootstrap cached by the backend. Dispose the SDK while preserving its
      // stored (possibly rotated) session so the next connection can recover.
      const revoke=error?.cloudAccessDenied===true||[401,403].includes(error?.status);
      if(this.epoch===epoch){await this.logout({flush:false,preserveOffline:scope,revoke});this.#status('offline','Não foi possível conectar à nuvem. Sua biblioteca local continua disponível.');}
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
      const result=await query;if(result.error)throw safeError();
      const page=(result.data||[]).filter(row=>row.user_id===scope.userId&&row.provider===scope.provider);rows.push(...page);
      if((result.data||[]).length<1000){let merged=rows;for(const value of this.optimisticRows.values())if(value.table===table)merged=replaceRecord(merged,value.row,table);return merged;}
    }
    throw safeError();
  }
  async load({force=false}={}){
    if(!this.client||!this.scope||!this.queryClient)return null;
    const epoch=this.epoch,client=this.client,queryClient=this.queryClient;
    try{
      const rows=await Promise.all(USER_TABLES.map(table=>queryClient.fetchQuery({queryKey:this.#key(table),gcTime:Infinity,staleTime:force?0:30000,queryFn:({signal})=>this.#readTable(table,signal)})));
      if(!this.#current(epoch,client))return null;
      USER_TABLES.forEach((table,index)=>{this.rows[table]=rows[index];});this.ready=true;this.#publish();return this.snapshot();
    }catch{if(this.#current(epoch,client))this.#status('offline','Sincronização temporariamente indisponível. Seus dados locais foram mantidos.');return null;}
  }
  #subscribeRealtime(epoch,client){
    const scope=this.scope;
    let channel=client.channel(`arkhen-library:${scope.provider}:${scope.userId}`);
    for(const table of USER_TABLES)for(const event of ['INSERT','UPDATE'])channel=channel.on('postgres_changes',{event,schema:'public',table,filter:`user_id=eq.${scope.userId}`},payload=>{
      if(!this.#current(epoch,client))return;
      const row=payload.new||payload.old;if(row?.provider&&row.provider!==scope.provider)return;
      void this.queryClient.invalidateQueries({queryKey:this.#key(table),refetchType:'all'}).catch(()=>{});
    });
    for(const table of SHARED_TABLES)for(const event of ['INSERT','UPDATE'])channel=channel.on('postgres_changes',{event,schema:'public',table,...(table==='episode_skip_markers'?{}:{filter:`provider_key=eq.${scope.providerKey}`})},()=>{
      if(!this.#current(epoch,client))return;
      void this.queryClient.invalidateQueries({queryKey:this.#key(table),refetchType:'all'}).catch(()=>{});this.onSharedUpdate({table});
    });
    channel=channel.on('postgres_changes',{event:'UPDATE',schema:'public',table:'profiles',filter:`id=eq.${scope.userId}`},payload=>{
      if(!this.#current(epoch,client)||payload.new?.id!==scope.userId)return;
      if(!this.#profileActive(payload.new)||payload.new.provider!==scope.provider||payload.new.provider_key!==scope.providerKey||payload.new.scope_hash!==scope.scopeHash)void this.logout({flush:false}).then(()=>{if(!this.scope)this.#status('restricted','O acesso à biblioteca precisa ser validado novamente. Entre na sua conta.');});
    });
    this.channel=channel.subscribe(status=>{if(this.#current(epoch,client)&&['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status))this.#status('offline','Atualização em tempo real indisponível. Seus dados locais foram mantidos.');});
  }
  #row(table,value){
    const scope=this.scope||this.offlineScope;if(!scope)return null;
    return {user_id:scope.userId,provider:scope.provider,...value,updated_at:this.#stamp()};
  }
  async #write(table,row){
    if(!row||!this.outbox.put(table,row))return false;
    if(!this.ready)return true;
    const epoch=this.epoch,client=this.client,queryClient=this.queryClient,key=this.#key(table),revisionKey=`${table}:${recordIdentity(table,row)}`,revision=row.updated_at;
    this.revisions.set(revisionKey,revision);
    const mutation=queryClient.getMutationCache().build(queryClient,{
      mutationKey:[...key,recordIdentity(table,row)],
      mutationFn:async()=>{
        if(!this.#current(epoch,client))return false;
        const controller=new AbortController();this.writeControllers.add(controller);
        try{
          const result=await client.from(table).upsert(row,{onConflict:conflict[table]}).select('*').abortSignal(controller.signal);
          if(result.error)throw safeError();return result.data?.[0]||row;
        }finally{this.writeControllers.delete(controller);}
      },
      onMutate:async()=>{
        await queryClient.cancelQueries({queryKey:key});if(!this.#current(epoch,client)||this.revisions.get(revisionKey)!==revision)return null;
        const previous=queryClient.getQueryData(key)||[],old=previous.find(entry=>recordIdentity(table,entry)===recordIdentity(table,row));
        this.optimisticRows.set(revisionKey,{table,row});queryClient.setQueryData(key,replaceRecord(previous,row,table));return {old};
      },
      onError:(_,__,previous)=>{
        if(!this.#current(epoch,client))return;
        if(this.revisions.get(revisionKey)===revision&&previous){
          this.optimisticRows.delete(revisionKey);
          const remaining=(queryClient.getQueryData(key)||[]).filter(entry=>recordIdentity(table,entry)!==recordIdentity(table,row));
          queryClient.setQueryData(key,previous.old?[...remaining,previous.old]:remaining);
        }
        this.#status('offline','A alteração continua salva neste aparelho e aguarda sincronização.');
      },
      onSuccess:stored=>{if(this.#current(epoch,client)&&stored){this.outbox.acknowledge(table,row);if(this.revisions.get(revisionKey)===revision)queryClient.setQueryData(key,replaceRecord(queryClient.getQueryData(key)||[],stored,table));}},
      onSettled:()=>{if(this.#current(epoch,client)){if(this.revisions.get(revisionKey)===revision)this.optimisticRows.delete(revisionKey);void queryClient.invalidateQueries({queryKey:key,refetchType:'all'}).catch(()=>{});}}
    });
    try{return Boolean(await mutation.execute(row));}catch{return false;}
  }
  saveFavorite(value,active=true){const item=cloudItem(value);if(!item)return Promise.resolve(false);return this.#write('user_favorites',this.#row('user_favorites',{item_key:itemKey(item),item,deleted_at:active?null:new Date(this.now()).toISOString()}));}
  saveProgress(value,{force=false}={}){
    const entry=cloudProgress(value),scope=this.scope||this.offlineScope;if(!entry||!scope||value.libraryId&&scope.libraryId&&value.libraryId!==scope.libraryId)return Promise.resolve(false);
    const row=this.#row('user_progress',{item_key:itemKey(entry.item),episode_id:entry.episode?.id||'',entry,deleted_at:null});
    this.outbox.put('user_progress',row);if(!this.ready)return Promise.resolve(true);
    this.progressQueue.set(recordIdentity('user_progress',row),row);
    if(force)return this.flushProgress();
    if(this.progressTimer===null)this.progressTimer=this.schedule(()=>{this.progressTimer=null;void this.flushProgress().catch(()=>{});},5000);
    return Promise.resolve(true);
  }
  async flushProgress({keepalive=false}={}){
    if(this.progressTimer!==null)this.cancel(this.progressTimer);this.progressTimer=null;
    if(!this.ready||!this.progressQueue.size)return true;
    const epoch=this.epoch,client=this.client,entries=[...this.progressQueue.entries()];this.progressQueue.clear();
    if(keepalive&&this.fetch&&this.accessToken){
      try{
        const response=await this.fetch(`${this.scope.url}/rest/v1/user_progress?on_conflict=${encodeURIComponent(conflict.user_progress)}`,{method:'POST',keepalive:true,
          headers:{apikey:this.scope.publishableKey,Authorization:`Bearer ${this.accessToken}`,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(entries.map(([,row])=>row))});
        if(response.ok){if(this.#current(epoch,client))for(const [,row]of entries)this.outbox.acknowledge('user_progress',row);return true;}
      }catch{/* Local progress remains the fallback when the tab loses connectivity. */}
      if(this.#current(epoch,client))for(const [key,row]of entries)if(!this.progressQueue.has(key))this.progressQueue.set(key,row);return false;
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
  async flushOutbox(){if(!this.ready)return false;const entries=this.outbox.entries();const results=[];for(const {table,row}of entries){if(!this.ready)return false;results.push(await this.#write(table,row));}return results.every(Boolean);}
  async syncLocal({libraryId,favoritesMap,historyMap,episodeEntries=[]}={}){
    if(!this.ready||!libraryId||libraryId!==this.scope.libraryId)return false;
    const epoch=this.epoch,client=this.client;
    const favorites=new Map(this.snapshot().favoriteRecords.map(row=>[row.item_key,row]));
    for(const value of favoritesMap?.values?.()||[]){if(!this.#current(epoch,client))return false;const item=cloudItem(value);if(!item)continue;const remote=favorites.get(itemKey(item));if(remote&&millis(remote.updated_at)>=millis(value.savedAt))continue;await this.saveFavorite(item,true);}
    const progress=new Map(this.snapshot().progressRecords.map(row=>[recordIdentity('user_progress',row),row]));
    for(const value of [...(historyMap?.values?.()||[]),...episodeEntries]){
      if(!this.#current(epoch,client))return false;
      if(value.libraryId&&value.libraryId!==libraryId)continue;const entry=cloudProgress(value);if(!entry)continue;
      const key=JSON.stringify([itemKey(entry.item),entry.episode?.id||'']),remote=progress.get(key);if(remote&&millis(remote.updated_at)>=entry.updated)continue;
      await this.saveProgress({...entry,libraryId},{force:true});
    }
    return true;
  }
  hydrate({favoritesMap,historyMap,episodeProgress}={}){
    if(!this.ready)return null;const snapshot=this.snapshot();
    if(favoritesMap)for(const row of snapshot.favoriteRecords){const local=favoritesMap.get(row.item_key);if(local&&millis(local.savedAt)>millis(row.updated_at))continue;if(row.deleted_at)favoritesMap.delete(row.item_key);else{const item=cloudItem(row.item);if(item&&itemKey(item)===row.item_key)favoritesMap.set(row.item_key,{...item,savedAt:millis(row.updated_at)});}}
    if(historyMap){
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
  async markerManifest(seriesSlug){
    const series=markerSeriesBySlug(seriesSlug);if(!this.ready||!series)return null;
    const epoch=this.epoch,client=this.client;
    try{
      const rows=await this.queryClient.fetchQuery({queryKey:this.#key('episode_skip_markers',seriesSlug),staleTime:300000,queryFn:async({signal})=>{
        const result=await client.from('episode_skip_markers').select('*').eq('series_slug',seriesSlug).eq('is_active',true).order('season').order('episode').abortSignal(signal);
        if(result.error)throw safeError();return result.data||[];
      }});
      if(!this.#current(epoch,client)||!rows.length)return null;
      const compatible=rows.filter(row=>(row.tmdb_id==null||Number(row.tmdb_id)===series.tmdbId)&&(row.imdb_id==null||row.imdb_id===series.imdbId));if(!compatible.length)return null;
      return {schemaVersion:1,dataVersion:compatible[0].data_version||'supabase',series:{slug:series.slug,title:series.title,tmdbId:series.tmdbId,imdbId:series.imdbId},records:compatible.map(row=>({season:row.season,episode:row.episode,edition:{id:row.edition_id,durationSeconds:Number(row.duration_seconds),toleranceSeconds:Number(row.tolerance_seconds),...(/^[a-f0-9]{16}$/.test(row.provenance?.edition?.sourceFingerprint||'')?{sourceFingerprint:row.provenance.edition.sourceFingerprint}:{})},verification:{...(row.provenance?.verification||{}),status:row.verification},markers:row.markers,sources:row.provenance?.sources||[]}))};
    }catch{return null;}
  }
  async logout({flush=true,cancelConnect=true,preserveOffline=null,revoke=true}={}){
    if(cancelConnect)++this.connectRequest;
    const request=this.connectRequest,startingEpoch=this.epoch,startingClient=this.client;
    if(flush){await this.flushProgress();await this.flushOutbox();}
    if(request!==this.connectRequest||startingEpoch!==this.epoch||startingClient!==this.client)return this.cleanupPending;
    ++this.epoch;const client=this.client;this.ready=false;this.scope=null;this.client=null;this.accessToken=null;
    if(this.progressTimer!==null)this.cancel(this.progressTimer);this.progressTimer=null;this.progressQueue.clear();
    for(const controller of this.writeControllers)controller.abort();this.writeControllers.clear();
    this.authSubscription?.unsubscribe();this.authSubscription=null;this.queryUnsubscribe?.();this.queryUnsubscribe=null;
    const queryClient=this.queryClient;this.queryClient=null;if(queryClient){void queryClient.cancelQueries();queryClient.clear();queryClient.unmount();}
    const channel=this.channel;this.channel=null;this.rows=emptyRows();this.revisions.clear();this.optimisticRows.clear();this.offlineScope=preserveOffline;this.outbox.setScope(preserveOffline);this.#status('local','Biblioteca salva neste aparelho.');
    if(client)this.cleanupPending=this.cleanupPending.catch(()=>{}).then(async()=>{
      if(channel)await client.removeChannel(channel).catch(()=>{});
      if(revoke)await client.auth.signOut({scope:'local'}).catch(()=>{});
      await client.auth.dispose?.().catch(()=>{});
    });
    await this.cleanupPending;
  }
  async dispose(){await this.logout();this.pageTarget?.removeEventListener?.('pagehide',this.pagehide);this.pageTarget?.removeEventListener?.('online',this.online);this.listeners.clear();}
}
