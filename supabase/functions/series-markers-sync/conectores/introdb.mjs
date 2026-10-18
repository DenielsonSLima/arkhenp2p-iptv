/** IntroDB is a separate episode reference, never a timestamp intersection. */
export class IntroDBMarkers {
  constructor(http){this.http=http;}
  segments({imdb_id,season,episode}){
    const query=new URLSearchParams({imdb_id,season:String(season),episode:String(episode)});
    return this.http.json('introdb','/segments?'+query);
  }
}
