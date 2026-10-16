import {millis} from './cloud-library-records.js';
import {libraryChangeSet} from './library-selectors.js';

const browserStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};
const encoded=value=>{try{return JSON.stringify(value);}catch{return '';}};
const collection=value=>({id:value.id,name:value.name,collection_type:value.type,item_keys:value.itemKeys||[]});

/** App glue lives here so local persistence, remote changes and render callbacks
 * cannot accidentally teach each other a second mutation. */
export class CloudAppBridge {
  constructor({cloud,getSession,getGeneration=()=>0,favoritesMap,historyMap,episodeProgress,localLibrary,getPreferences=()=>({}),applyPreferences=()=>{},
    getCollections=()=>[],applyCollections=()=>{},defaultPreferences={},onUpdate=()=>{},onStatus=()=>{},storage=browserStorage(),now=Date.now,refreshSession,
    pageTarget=globalThis.window,schedule=(callback,delay)=>globalThis.setTimeout(callback,delay),cancel=timer=>globalThis.clearTimeout(timer)}={}){
    Object.assign(this,{cloud,getSession,getGeneration,favoritesMap,historyMap,episodeProgress,localLibrary,getPreferences,applyPreferences,getCollections,applyCollections,defaultPreferences,onUpdate,onStatus,storage,now,refreshSession,pageTarget,schedule,cancel});
    this.serial=0;this.applying=false;this.account=null;this.preferenceRecords={};this.collectionRecords={};this.knownCollections=new Map();
    this.retryTimer=null;this.retryAttempt=0;this.connecting=null;this.lastSnapshot=null;
    this.recover=()=>{if(this.account)void this.#connect(this.serial,this.getGeneration(),{refresh:true});};
    pageTarget?.addEventListener?.('online',this.recover);pageTarget?.addEventListener?.('focus',this.recover);
    this.unsubscribe=cloud.subscribe(snapshot=>this.receive(snapshot));
  }
  #key(){return this.account?`arkhen.cloud-ui.v1.${this.account}`:'';}
  #persist(){if(!this.account)return;try{this.storage?.setItem(this.#key(),JSON.stringify({version:1,account:this.account,preferences:this.preferenceRecords,collections:this.collectionRecords}));}catch{/* The module's outbox and the local library remain usable. */}}
  #local(){let saved;try{saved=JSON.parse(this.storage?.getItem(this.#key())||'null');}catch{}return saved?.account===this.account?saved:null;}
  #current(serial,generation){return this.serial===serial&&this.getGeneration()===generation&&this.getSession()?.account?.libraryId===this.account;}
  #ui(callback,stage){try{return callback();}catch{globalThis.console?.warn?.('[arkhen.cloud]',{code:'CLOUD_UI_CALLBACK_FAILED',stage});}}
  async start(){
    this.#cancelRetry();this.retryAttempt=0;
    const session=this.getSession(),serial=++this.serial,generation=this.getGeneration();this.account=session?.account?.libraryId||null;
    this.preferenceRecords={};this.collectionRecords={};this.knownCollections=new Map();if(!this.account)return null;
    this.lastSnapshot=null;
    const saved=this.#local();this.preferenceRecords=saved?.preferences||{};this.collectionRecords=saved?.collections||{};
    const preferences={...this.defaultPreferences,...Object.fromEntries(Object.entries(this.preferenceRecords).map(([key,entry])=>[key,entry.value]))};
    this.applying=true;try{this.#ui(()=>this.applyPreferences(preferences),'initial_preferences');this.knownCollections=new Map(this.getCollections().map(group=>[group.id,{...group,itemKeys:[...group.itemKeys]}]));}finally{this.applying=false;}
    return this.#connect(serial,generation);
  }
  #cancelRetry(){if(this.retryTimer!==null)this.cancel(this.retryTimer);this.retryTimer=null;}
  #retry(serial,generation){
    if(!this.#current(serial,generation)||this.retryTimer!==null)return;
    this.retryTimer=this.schedule(()=>{this.retryTimer=null;void this.#connect(serial,generation,{refresh:true});},Math.min(60000,5000*2**Math.min(this.retryAttempt++,4)));
  }
  #connect(serial,generation,{refresh=false}={}){
    if(!this.#current(serial,generation))return Promise.resolve(null);
    if(this.connecting?.serial===serial)return this.connecting.promise;
    this.#cancelRetry();
    const operation={serial,promise:null};this.connecting=operation;
    operation.promise=(async()=>{
      try{
        // A provider login can outlive a backend restart or cloud configuration.
        // Fetch a fresh bootstrap before retrying a disabled/expired connection.
        if(refresh&&this.refreshSession)await this.refreshSession();
        if(!this.#current(serial,generation))return null;
        const session=this.getSession(),bootstrap=session?.cloud||null;let waitingBootstrap=!bootstrap;
        // Provisioning has its own backend deadline and may outlive login.
        // Never feed its temporary null result to the explicit Auth lifecycle.
        let snapshot=bootstrap?await this.cloud.connect(bootstrap):await this.cloud.resume?.({libraryId:this.account,pending:session?.cloudStatus?.state==='pending',code:session?.cloudStatus?.code});
        if(!snapshot&&this.cloud.getConnectionFailure?.()?.authRecoveryRequired===true&&this.refreshSession&&this.#current(serial,generation)){
          // Only a rejected Auth session may mint a replacement. A rendering,
          // network or profile-policy failure must not request this capability.
          await this.refreshSession({forceCloud:true});
          if(!this.#current(serial,generation))return null;
          const recovered=this.getSession()?.cloud;
          if(recovered){waitingBootstrap=false;snapshot=await this.cloud.connect(recovered,{preferBootstrap:true});}
        }
        if(!this.#current(serial,generation))return null;
        if(waitingBootstrap)this.#retry(serial,generation);
        if(!snapshot){this.#retry(serial,generation);return null;}
        await this.syncLocal();
        if(!this.#current(serial,generation))return null;
        // Empty cloud preferences/collections adopt only this account's local state.
        const current=this.cloud.snapshot(),remoteKeys=new Set((current.preferenceRecords||[]).map(row=>row.key));
        for(const [key,value]of Object.entries(this.getPreferences())){if(!this.#current(serial,generation))return null;if(!remoteKeys.has(key))await this.preferenceChanged(key,value,{force:true});}
        const remoteGroups=new Set((current.collectionRecords||[]).map(row=>row.id));
        for(const group of this.getCollections()){if(!this.#current(serial,generation))return null;if(!remoteGroups.has(group.id))await this.cloud.saveCollection(collection(group));}
        if(!waitingBootstrap)this.retryAttempt=0;return this.cloud.snapshot();
      }catch{this.#retry(serial,generation);return null;}
      finally{if(this.connecting===operation)this.connecting=null;}
    })();
    return operation.promise;
  }
  #episodeEntries(){
    const result=[];
    for(const record of this.episodeProgress.list()){
      const key=`series:${record.itemId}`,item=this.favoritesMap.get(key)||this.historyMap.get(key)?.item;if(!item)continue;
      result.push({item,episode:{id:record.episodeId,season:record.season,number:record.number,title:''},time:record.time,duration:record.duration||0,completed:record.completed,updated:record.updated,libraryId:this.account});
    }
    return result;
  }
  receive(snapshot){
    const session=this.getSession(),scope=this.cloud.scope,expectedUser=session?.cloud?.userId||(scope?.libraryId===this.account?scope.userId:null);
    if(!this.account||!snapshot.ready||snapshot.userId!==expectedUser||session?.account?.libraryId!==this.account)return;
    const changes=libraryChangeSet(this.lastSnapshot,snapshot);this.lastSnapshot=snapshot;
    this.applying=true;
    try{
      this.cloud.hydrate({favoritesMap:this.favoritesMap,historyMap:this.historyMap,episodeProgress:this.episodeProgress});
      if(changes.initial||changes.favorites.length)this.#ui(()=>this.localLibrary.saveFavorites(),'local_favorites');
      if(changes.initial||changes.progress.length)this.#ui(()=>this.localLibrary.saveHistory(),'local_history');
      const preferences={};
      for(const row of snapshot.preferenceRecords||[]){
        const old=this.preferenceRecords[row.key],updated=millis(row.updated_at);if(old&&old.updated>updated)continue;
        if(row.deleted_at){delete this.preferenceRecords[row.key];if(Object.hasOwn(this.defaultPreferences,row.key))preferences[row.key]=this.defaultPreferences[row.key];}
        else{this.preferenceRecords[row.key]={value:row.value,updated};if(!old||encoded(old.value)!==encoded(row.value))preferences[row.key]=row.value;}
      }
      if(Object.keys(preferences).length)this.#ui(()=>this.applyPreferences(preferences),'preferences');
      const groups=new Map(this.getCollections().map(group=>[group.id,group]));let groupsChanged=false;
      for(const row of snapshot.collectionRecords||[]){
        const old=this.collectionRecords[row.id],updated=millis(row.updated_at);if(old&&old.updated>updated)continue;
        this.collectionRecords[row.id]={updated,deleted:Boolean(row.deleted_at)};
        if(row.deleted_at){groupsChanged=groups.delete(row.id)||groupsChanged;}
        else{const group={id:row.id,name:row.name,type:row.collection_type,itemKeys:row.item_keys||[]};if(encoded(groups.get(row.id))!==encoded(group)){groups.set(row.id,group);groupsChanged=true;}}
      }
      if(groupsChanged)this.#ui(()=>this.applyCollections([...groups.values()]),'collections');
      this.knownCollections=new Map(this.getCollections().map(group=>[group.id,{...group,itemKeys:[...group.itemKeys]}]));this.#persist();
      if(changes.initial||['favorites','progress','preferences','collections'].some(key=>changes[key].length))this.#ui(()=>this.onUpdate(snapshot,changes),'render');
    }finally{this.applying=false;}
  }
  preferenceChanged(key,value,{force=false}={}){
    if(this.applying||!this.account)return Promise.resolve(false);
    const old=this.preferenceRecords[key];if(!force&&old&&encoded(old.value)===encoded(value))return Promise.resolve(true);
    this.preferenceRecords[key]={value,updated:this.now()};this.#persist();return this.cloud.savePreference(key,value);
  }
  settingsChanged(){
    if(this.applying||!this.account)return;
    for(const [key,value]of Object.entries(this.getPreferences()))void this.preferenceChanged(key,value);
    const groups=new Map(this.getCollections().map(group=>[group.id,group]));
    for(const group of groups.values())if(encoded(group)!==encoded(this.knownCollections.get(group.id))){this.collectionRecords[group.id]={updated:this.now(),deleted:false};void this.cloud.saveCollection(collection(group));}
    for(const [id,group]of this.knownCollections)if(!groups.has(id)){this.collectionRecords[id]={updated:this.now(),deleted:true};void this.cloud.removeCollection(collection(group));}
    this.knownCollections=new Map([...groups].map(([id,group])=>[id,{...group,itemKeys:[...group.itemKeys]}]));this.#persist();
  }
  favoriteChanged(item,active){if(this.applying||!this.account)return Promise.resolve(false);return this.cloud.saveFavorite(item,active);}
  progressChanged(entry,{force=false}={}){if(this.applying||!this.account)return Promise.resolve(false);return this.cloud.saveProgress(entry,{force});}
  syncLocal(){return this.account?this.cloud.syncLocal({libraryId:this.account,favoritesMap:this.favoritesMap,historyMap:this.historyMap,episodeEntries:this.#episodeEntries()}):Promise.resolve(false);}
  async stop({flush=true}={}){const serial=++this.serial;this.#cancelRetry();this.retryAttempt=0;this.connecting=null;this.account=null;await this.cloud.logout({flush});if(this.serial!==serial)return;this.preferenceRecords={};this.collectionRecords={};this.knownCollections.clear();}
  async dispose(){await this.stop();this.unsubscribe?.();this.pageTarget?.removeEventListener?.('online',this.recover);this.pageTarget?.removeEventListener?.('focus',this.recover);}
}
