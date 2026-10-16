export function selectRecentSeriesShelf(context){
  const items=context.recent('series');
  return items.length?{key:'home:series-history',title:'Últimas séries assistidas',type:'series',items}:null;
}
