const normalize=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const marker=/(?:^|[^a-z0-9])(?:adult(?:o|a|os|as|s)?|xxx|porn(?:o|os|ografia|ographic)?|erotic(?:o|a|os|as)?|hentai)(?=$|[^a-z0-9])|(?:^|[^0-9])(?:\+\s*18|18\s*\+)(?=$|[^0-9])/;
export function hasAdultMarker(value,{category=false}={}){
  const name=normalize(value).replace(/\badult\s+swim\b/g,'');
  return marker.test(name)||category&&/(?:^|[^a-z0-9])18(?=$|[^a-z0-9])/.test(name);
}
export function isAdultCategory(category){return Boolean(category?.adult===true||category?.isAdult===true||category?.is_adult===true||hasAdultMarker(category?.name??category,{category:true}));}
export function isAdultItem(item,categories=[]){
  if(!item)return false;
  if(item.adult===true||item.isAdult===true||item.is_adult===true)return true;
  const ids=new Set((Array.isArray(item.categoryIds)?item.categoryIds:[item.categoryId]).filter(value=>value!==undefined&&value!==null).map(String));
  if((Array.isArray(categories)?categories:[]).some(category=>isAdultCategory(category)&&[...(Array.isArray(category?.ids)||category?.ids instanceof Set?category.ids:[category?.id])].some(id=>ids.has(String(id)))))return true;
  return [item.group,item.categoryName,item.category_name,...(Array.isArray(item.groupNames)?item.groupNames:[])].some(value=>hasAdultMarker(value,{category:true}))||hasAdultMarker(item.name??item.title);
}
