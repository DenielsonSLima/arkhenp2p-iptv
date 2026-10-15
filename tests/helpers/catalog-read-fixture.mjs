export const catalogSnapshotId='d243589c-25c5-4db0-b9aa-c087ace3d180';
export function catalogReadFixture({items=[],categories=[],...overrides}={}){
  const header={expires_at:'2070-01-01T00:00:00Z',is_complete:true,snapshot_id:catalogSnapshotId,index_generation:catalogSnapshotId,updated_at:'2026-10-15T15:00:00Z',item_count:items.length,safe_item_count:items.filter(item=>!item.isAdult).length,...overrides};
  return path=>{
    const url=new URL(path,'https://fixture.example'),offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||1000),type=url.searchParams.get('media_type')?.slice(3);
    if(url.pathname==='/rest/v1/provider_catalog_cache')return[{...header}];
    if(url.pathname==='/rest/v1/catalog_categories')return categories.slice(offset,offset+limit).map(category=>({category_id:category.id,name:category.name,is_adult:Boolean(category.isAdult),generation_id:header.index_generation}));
    if(url.pathname==='/rest/v1/catalog_media')return items.slice(offset,offset+limit).map(item=>({media_id:String(item.id),media_type:type,metadata:item,is_adult:Boolean(item.isAdult),generation_id:header.index_generation}));
    return[];
  };
}
