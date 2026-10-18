import test from 'node:test';import assert from 'node:assert/strict';
import {reviewCatalogTitle,prioritizedReviewSeries,reviewedSeriesIdentity} from '../lib/serie/marcadores/revisao.mjs';
test('review selection uses only real supplied provider items, prioritizes existing app items and balances catalog categories',()=>{
 const pool=Array.from({length:12},(_,i)=>({id:String(i),name:'Série '+i,kind:'series',rating:i,sourceCategory:{name:i%2?'A':'B'}}));const rows=prioritizedReviewSeries(pool,[{id:'100',name:'Já no app',kind:'series'}],5);
 assert.equal(rows.length,5);assert.equal(rows[0].id,'100');assert.ok(rows.slice(1).every(row=>pool.some(item=>item.id===row.id)));assert.equal(new Set(rows.slice(1).map(row=>row.sourceCategory.name)).size,2);
});
test('localized identities need an exact source alias, the same IMDb link and matching TV type and release year',()=>{
 const item={name:'Falcao e o Soldado Invernal - 2021 (LEG)',year:'2021'},imdbPayload={d:[{id:'tt9208876',l:'The Falcon and the Winter Soldier',y:2021,qid:'tvMiniSeries'}]},entity={id:'Q65979734',labels:{en:{value:'The Falcon and the Winter Soldier'}},aliases:{pt:[{value:'Falcão e o Soldado Invernal'}]},claims:{P345:[{mainsnak:{datavalue:{value:'tt9208876'}}}]}};
 assert.equal(reviewCatalogTitle(item).name,'Falcao e o Soldado Invernal');assert.equal(reviewedSeriesIdentity(item,{imdbPayload}).status,'unresolved');
 assert.equal(reviewedSeriesIdentity(item,{imdbPayload,wikidataEntities:{Q65979734:entity}}).identity.imdb_id,'tt9208876');
 assert.equal(reviewedSeriesIdentity({...item,year:2020},{imdbPayload,wikidataEntities:{Q65979734:entity}}).reason,'CATALOG_YEAR_CONFLICT');
 assert.equal(reviewedSeriesIdentity(item,{imdbPayload:{d:[{...imdbPayload.d[0],qid:'movie'}]},wikidataEntities:{Q65979734:entity}}).status,'unresolved');
 const rings=reviewedSeriesIdentity({name:'O Senhor Dos Aneis Os Aneis De Poder - 2022',year:'2022'},{imdbPayload:{d:[{id:'tt7631058',l:'The Lord of the Rings: The Rings of Power',y:2022,qid:'tvSeries'}]}});
 assert.equal(rings.identity.imdb_id,'tt7631058');assert.equal(rings.identity.method,'curated-exact-alias-and-imdb-type-year');
});
