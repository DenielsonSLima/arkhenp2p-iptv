/** Category DOM is shared; selected state and permissions stay with each tab. */
export function createCatalogSidebar({node,button,icon,normalize,reconcileChildren,getState,onSelect,onManage,formatNumber}){
function updateCategoryButton(chip,group,live=false){
  const {category}=getState();
  chip.classList.toggle('active',category===group.id);chip.classList.toggle('category-protected',group.protected===true);chip.setAttribute('aria-pressed',String(category===group.id));chip.setAttribute('aria-label',group.locked?group.name+' - bloqueado':group.name);chip.dataset.categoryId=group.id;chip.dataset.categorySearch=normalize(group.name);chip.firstElementChild.textContent=group.name;
  if(live){const total=chip.lastElementChild;total.hidden=Boolean(group.utility);if(group.locked)total.replaceChildren(icon('lock'));else total.textContent=group.utility?'':group.unloaded?'\u2014':formatNumber(group.count);}
  return chip;
}
function categoryButtons(groups,live=false){
  return groups.map(group=>{const chip=button('',live?'live-category':'category-chip',()=>void onSelect(group.id));chip.append(node('span','',group.name));if(live)chip.append(node('span','category-total'));return updateCategoryButton(chip,group,live);});
}
function updateCategorySidebar(sidebar,groups){
  if(!sidebar)return;const list=sidebar.querySelector('.category-sidebar-items'),search=normalize(sidebar.querySelector('.category-sidebar-search').value),existing=new Map([...list.children].map(element=>[element.dataset.categoryId,element]));
  const choices=groups.map(group=>{const chip=updateCategoryButton(existing.get(group.id)||categoryButtons([group],true)[0],group,true);chip.hidden=!chip.dataset.categorySearch.includes(search);return chip;});
  const scrollTop=list.scrollTop;reconcileChildren(list,choices);list.scrollTop=scrollTop;
}
function categorySidebar(groups){
  const {view}=getState();
  const sidebar=node('aside','live-categories catalog-sidebar');sidebar.setAttribute('aria-label','Categorias');
  const heading=node('div','category-sidebar-heading');heading.append(node('h2','','CATEGORIAS'));
  const toggle=button('Categorias','mobile-categories-toggle',()=>{sidebar.classList.toggle('mobile-expanded');toggle.setAttribute('aria-expanded',String(sidebar.classList.contains('mobile-expanded')));},'chevron-down');toggle.setAttribute('aria-expanded','false');heading.append(toggle);sidebar.append(heading);
  const search=node('input','category-sidebar-search');search.type='search';search.placeholder='Buscar categoria';search.setAttribute('aria-label','Buscar categoria');sidebar.append(search);
  const actions=node('div','category-sidebar-actions');actions.append(button('Organizar','category-manage',()=>onManage(view),'settings'));sidebar.append(actions);
  const list=node('div','category-sidebar-items');list.append(...categoryButtons(groups,true));sidebar.append(list);
  search.addEventListener('input',()=>{const text=normalize(search.value);for(const option of list.children)option.hidden=!option.dataset.categorySearch.includes(text);});
  return sidebar;
}

return {buttons:categoryButtons,create:categorySidebar,update:updateCategorySidebar};
}
