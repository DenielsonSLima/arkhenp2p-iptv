import test from 'node:test';
import assert from 'node:assert/strict';
import {homeRecommendationState} from '../web/home-recommendations-state.js';
import {cloudHomeSections} from '../web/home-cloud-sections.js';
test('an unavailable recommendation projection remains visible as a retry state without inventing candidates',()=>{
  assert.deepEqual(homeRecommendationState(),{phase:'unavailable',message:'As recomendações estão temporariamente indisponíveis.',retry:true});
  assert.equal(homeRecommendationState({available:true,error:'failed'}).phase,'error');
  assert.equal(homeRecommendationState({available:true,loading:true}).phase,'loading');
  assert.equal(homeRecommendationState({available:true,data:{recommendations:{items:[]}}}).phase,'empty');
});
test('recommendations follow series releases and describe the actual server personalization',()=>{
  const film={id:'1',kind:'movie',name:'Filme'},series={id:'2',kind:'series',name:'Série'};
  const catalog=item=>({items:[item],itemMap:new Map([[item.id,item]]),readModel:{orders:{releases:[item.id]}}});
  const catalogs=new Map([['movies',catalog(film)],['series',catalog(series)]]);
  for(const personalized of [true,false]){
    const sections=cloudHomeSections({catalogs,privateModel:{recommendations:{personalized,items:[film]}}});
    const index=sections.findIndex(section=>section.key==='home:recommendations');
    assert.equal(sections[index-1].key,'home:series-releases');assert.equal(sections[index].title,'Recomendados para você');
    assert.match(sections[index].subtitle,personalized?/você assiste/:/bem avaliados/);
  }
});
