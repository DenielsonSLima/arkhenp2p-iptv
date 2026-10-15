import {millis} from './cloud-library-records.js';

const browserStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};
const encoded=value=>{try{return JSON.stringify(value);}catch{return '';}};
const collection=value=>({id:value.id,name:value.name,collection_type:value.type,item_keys:value.itemKeys||[]});

/** App glue lives here so local persistence, remote changes and render callbacks
 * cannot accidentally teach each other a second mutation. */
export class CloudAppBridge {
  constructor({cloud,getSession,getGeneration=()=>0,favoritesMap,historyMap,episodeProgress,localLibrary,getPreferences=()=>({}),applyPreferences=()=>{},
    getCollections=()=>[],applyCollections=()=>{},defaultPreferences={},onUpdate=()=>{},onStatus=()=>{},storage=browserStorage(),now=Date.now}={}){
    Object.assign(this,{cloud,getSession,getGeneration,favoritesMap,historyMap,episodeProgress,localLibrary,getPreferences,applyPreferences,getCollections,applyCollections,defaultPreferences,onUpdate,onStatus,storage,now});
    this.serial=0;this.applying=false;this.account=null;this.preferenceRecords={};this.collectionRecords={};this.knownCollections=new Map();
    this.unsubscribe=cloud.subscribe(snapshot=>this.receive(snapshot));
  }
  #key(){return this.account?`arkhen.cloud-ui.v1.${this.account}`:'';}
  #persist(){if(!this.account)return;try{this.storage?.setItem(this.#key(),JSON.stringify({version:1,account:this.account,preferences:this.preferenceRecords,collections:this.collectionRecords}));}catch{/* The module's outbox and the local library remain usable. */}}
  #local(){let saved;try{saved=JSON.parse(this.storage?.getItem(this.#key())||'null');}catch{}return saved?.account===this.account?saved:null;}
  #current(serial,generation){return this.serial===serial&&this.getGeneration()===generation&&this.getSession()?.account?.libraryId===this.account;}
  async start(){
    const session=this.getSession(),serial=++this.serial,generation=this.getGeneration();this.account=session?.account?.libraryId||null;
    this.preferenceRecords={};this.collectionRecords={};this.knownCollections=new Map();if(!this.account)return null;
    const saved=this.#local();this.preferenceRecords=saved?.preferences||{};this.collectionRecords=saved?.collections||{};
    const preferences={...this.defaultPreferences,...Object.fromEntries(Object.entries(this.preferenceRecords).map(([key,entry])=>[key,entry.value]))};
    this.applying=true;try{this.applyPreferences(preferences);this.knownCollections=new Map(this.getCollections().map(group=>[group.id,{...group,itemKeys:[...group.itemKeys]}]));}finally{this.applying=false;}
    const snapshot=await this.cloud.connect(session.cloud);if(!snapshot||!this.#current(serial,generation))return null;
    await this.cloud.syncLocal({libraryId:this.account,favoritesMap:this.favoritesMap,historyMap:this.historyMap,episodeEntries:this.#episodeEntries()});
    if(!this.#current(serial,generation))return null;
    // Empty cloud preferences/collections adopt only this account's local state.
    const current=this.cloud.snapshot(),remoteKeys=new Set((current.preferenceRecords||[]).map(row=>row.key));
    for(const [key,value]of Object.entries(this.getPreferences())){if(!this.#current(serial,generation))return null;if(!remoteKeys.has(key))await this.preferenceChanged(key,value,{force:true});}
    const remoteGroups=new Set((current.collectionRecords||[]).map(row=>row.id));
    for(const group of this.getCollections()){if(!this.#current(serial,generation))return null;if(!remoteGroups.has(group.id))await this.cloud.saveCollection(collection(group));}
    return this.cloud.snapshot();
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
    const session=this.getSession();if(!this.account||!snapshot.ready||snapshot.userId!==session?.cloud?.userId||session?.account?.libraryId!==this.account)return;
    this.applying=true;
    try{
      this.cloud.hydrate({favoritesMap:this.favoritesMap,historyMap:this.historyMap,episodeProgress:this.episodeProgress});
      this.localLibrary.saveFavorites();this.localLibrary.saveHistory();
      const preferences={};
      for(const row of snapshot.preferenceRecords||[]){
        const old=this.preferenceRecords[row.key],updated=millis(row.updated_at);if(old&&old.updated>updated)continue;
        if(row.deleted_at){delete this.preferenceRecords[row.key];if(Object.hasOwn(this.defaultPreferences,row.key))preferences[row.key]=this.defaultPreferences[row.key];}
        else{this.preferenceRecords[row.key]={value:row.value,updated};if(!old||encoded(old.value)!==encoded(row.value))preferences[row.key]=row.value;}
      }
      if(Object.keys(preferences).length)this.applyPreferences(preferences);
      const groups=new Map(this.getCollections().map(group=>[group.id,group]));let groupsChanged=false;
      for(const row of snapshot.collectionRecords||[]){
        const old=this.collectionRecords[row.id],updated=millis(row.updated_at);if(old&&old.updated>updated)continue;
        this.collectionRecords[row.id]={updated,deleted:Boolean(row.deleted_at)};
        if(row.deleted_at){groupsChanged=groups.delete(row.id)||groupsChanged;}
        else{const group={id:row.id,name:row.name,type:row.collection_type,itemKeys:row.item_keys||[]};if(encoded(groups.get(row.id))!==encoded(group)){groups.set(row.id,group);groupsChanged=true;}}
      }
      if(groupsChanged)this.applyCollections([...groups.values()]);
      this.knownCollections=new Map(this.getCollections().map(group=>[group.id,{...group,itemKeys:[...group.itemKeys]}]));this.#persist();this.onUpdate(snapshot);
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
  async stop({flush=true}={}){const serial=++this.serial;this.account=null;await this.cloud.logout({flush});if(this.serial!==serial)return;this.preferenceRecords={};this.collectionRecords={};this.knownCollections.clear();}
}
