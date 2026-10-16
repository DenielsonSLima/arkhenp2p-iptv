export function selectSeriesReleaseShelf(context){
  const items=context.readOrder('series','releases');
  return items.length?{key:'home:series-releases',title:'Lançamentos de séries',type:'series',items}:null;
}
