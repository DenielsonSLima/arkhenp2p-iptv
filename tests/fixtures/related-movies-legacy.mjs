// Historical selector fixture. Production movie recommendations are RPC-owned.
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const generic = /^(?:filmes?|movies?|series?|cinema|outros|diversos|todos(?: os (?:filmes|titulos))?|lancamentos?|estreias?|recentes?|novidades?|destaques?|adicionados recentemente|sd|hd|fhd|uhd|4k|8k|legendados?|dublados?|dual audio|netflix|prime video|amazon prime|disney|hbo(?: max)?|max|globoplay|paramount|apple tv)$/;
const genres = item => new Set([item.genre,item.group,...(Array.isArray(item.groupNames)?item.groupNames:[])].filter(value=>typeof value==='string')
  .flatMap(value=>value.split(/[,|/]/)).map(value=>normalize(value).replace(/^(?:filmes?|movies?|series?)\s+/,'').replace(/\s+(?:19|20)\d{2}$/,''))
  .filter(value=>value&&!generic.test(value)&&!/^(?:19|20)\d{2}$/.test(value)));

export function relatedMovies(current, items, limit = 12) {
  const tags = genres(current), title = normalize(current.name), seen = new Set([title]);
  if(!tags.size)return [];
  return items.filter(item => item?.kind === 'movie' && String(item.id) !== String(current.id)).map(item => {
    const overlap = [...genres(item)].filter(tag => tags.has(tag)).length;
    // A shared shelf such as Releases is not evidence of a similar film.
    return {item, score:overlap};
  }).filter(entry => entry.score > 0).sort((a,b) => b.score - a.score || Number(b.item.rating || 0) - Number(a.item.rating || 0))
    .filter(({item}) => {const key = normalize(item.name);if(!key || seen.has(key))return false;seen.add(key);return true;})
    .slice(0, limit).map(({item}) => item);
}
