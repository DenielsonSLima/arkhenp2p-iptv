import {MarkerHttp} from './http.mjs';
import {SkipDBMarkers} from './skipdb.mjs';
import {IntroDBMarkers} from './introdb.mjs';

/** One request budget and cooldown state; explicit source adapters preserve
 * their own API semantics. The pipeline decides whether a fallback is needed. */
export class MarkerProviders {
  constructor(options={}){
    this.http=new MarkerHttp(options);
    this.skipdb=new SkipDBMarkers(this.http);
    this.introdb=new IntroDBMarkers(this.http);
  }
  get cooldowns(){return this.http.cooldowns;}
  health(){return this.http.health();}
  search(name){return this.skipdb.search(name);}
  inventory(imdb){return this.skipdb.inventory(imdb);}
  segments(source,episode){
    if(!['skipdb','introdb'].includes(source))throw Object.assign(new Error('PROVIDER_INVALID'),{code:'PROVIDER_INVALID'});
    return this[source].segments(episode);
  }
}
