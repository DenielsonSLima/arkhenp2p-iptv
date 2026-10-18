/** SkipDB title identity/inventory and unadjusted episode source timestamps. */
export class SkipDBMarkers {
  constructor(http){this.http=http;}
  search(name){return this.http.json('skipdb','/api/titles/search?q='+encodeURIComponent(name),{metadata:true});}
  inventory(imdb){return this.http.json('skipdb','/api/titles/'+encodeURIComponent(imdb),{metadata:true});}
  segments({imdb_id,season,episode}){
    const query=new URLSearchParams({imdb_id,season:String(season),episode:String(episode),adjust:'none'});
    return this.http.json('skipdb','/api/segments?'+query);
  }
}
