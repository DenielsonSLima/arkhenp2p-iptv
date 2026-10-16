import {formatAccessValidity} from '../access-validity.js';

/** Header displays provider expiry only; it never estimates account validity. */
export class SystemHeader{
  constructor({root=document,getSession=()=>null}={}){
    Object.assign(this,{root,getSession});this.wrapper=root.querySelector('#access-validity');
    this.label=root.querySelector('#access-validity-label');this.date=root.querySelector('#access-validity-date');
  }
  update(session=this.getSession()){
    const validity=formatAccessValidity(session);
    if(this.label)this.label.textContent=validity.label;
    if(this.date){this.date.textContent=validity.value;validity.dateTime?this.date.setAttribute('datetime',validity.dateTime):this.date.removeAttribute('datetime');}
    if(this.wrapper){this.wrapper.dataset.state=validity.state;this.wrapper.title=validity.title;this.wrapper.setAttribute('aria-label',validity.title);}
    return validity;
  }
}
