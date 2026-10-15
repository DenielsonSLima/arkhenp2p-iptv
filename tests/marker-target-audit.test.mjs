import test from 'node:test';
import assert from 'node:assert/strict';
import {MARKER_AUDIT_TARGETS,targetInventoryPlan,targetCatalogIdentity} from '../tools/refresh-marker-targets.mjs';
import {MarkerStore} from '../supabase/functions/series-markers-sync/store.mjs';
const now=Date.parse('2026-10-15T18:30:00Z');
const report=()=>({retrievedAt:new Date(now).toISOString(),titles:MARKER_AUDIT_TARGETS.map(target=>({url:'https://skipdb.tv/api/titles/'+target.imdb,status:200,payload:{imdb_id:target.imdb,year:target.year,media_type:'series',name:'Source title',episodes:[{season:1,episode:1},{season:2,episode:62},{season:0,episode:1},{season:target.maxSeason+1,episode:1}]}}))});
test('target planning validates public identities and excludes specials and later seasons from requested audits',()=>{
  const plan=targetInventoryPlan(report(),now);assert.equal(plan.length,6);
  for(const row of plan){assert.equal(row.episodes.length,4);assert.equal(row.requested.length,2);assert.equal(row.requested[1].episode,62);}
  const priority=[...plan].sort((a,b)=>b.priority-a.priority).map(row=>row.imdb);
  assert.equal(priority[0],'tt0944947');assert.equal(priority[1],'tt2306299');assert.equal(priority.at(-1),'tt7631058');
  const broken=report();broken.titles[0].payload.year=2017;assert.throws(()=>targetInventoryPlan(broken,now),{code:'AUDIT_INVENTORY_IDENTITY_INVALID'});
  assert.throws(()=>targetInventoryPlan(report(),now+86400001),{code:'AUDIT_INVENTORY_STALE'});
});
test('known native IDs cannot override a conflicting current title, year, media type or adult classification',()=>{
  const target=MARKER_AUDIT_TARGETS[1],row={media_type:'series',media_id:'999726546',name:'Vikings - 2013 (LEG)',metadata:{},is_active:true,is_adult:false};
  assert.equal(targetCatalogIdentity(row,target).imdb_id,'tt2306299');
  for(const delta of [{name:'Vikings Valhalla - 2022'},{media_type:'movies'},{is_adult:true},{is_active:false},{media_id:'other'}])assert.throws(()=>targetCatalogIdentity({...row,...delta},target),{code:'AUDIT_CATALOG_IDENTITY_INVALID'});
});
test('coverage completion compares the audit request and row revision so an older response cannot erase a newer request',async()=>{
  for(const requestedAt of [null,new Date(now).toISOString()]){
    const row={imdb_id:'tt0944947',season:5,episode:1,audit_requested_at:requestedAt,updated_at:new Date(now-1000).toISOString()};
    const store=new MarkerStore({url:'https://fixture.supabase.co',key:'fixture',fetch:async(url,options)=>{
      const query=new URL(url).searchParams;assert.equal(query.get('audit_requested_at'),requestedAt?'eq.'+requestedAt:'is.null');assert.equal(query.get('updated_at'),'eq.'+row.updated_at);assert.equal(options.headers.Prefer,'return=representation');return new Response('[]');
    }});
    assert.equal(await store.coverage(row,{audit_priority:0}),false);
  }
});
test('priority audits use their own due time so a daily dump cannot postpone them',async()=>{
  const store=new MarkerStore({url:'https://fixture.supabase.co',key:'fixture',fetch:async url=>{
    const query=new URL(url).searchParams;assert.equal(query.has('next_check_at'),false);assert.equal(query.get('audit_next_check_at'),'lte.'+new Date(now).toISOString());assert.equal(query.get('audit_priority'),'gt.0');assert.equal(query.get('limit'),'10');return new Response('[]');
  }});await store.auditDue(now,100);
});
