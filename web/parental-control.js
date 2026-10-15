import {isAdultItem} from './parental-classification.js';
const node=(tag,className='',text)=>{const element=document.createElement(tag);element.className=className;if(text!==undefined)element.textContent=text;return element;};
/** PIN exists only in the input for the duration of its submitted request. */
export class ParentalControlUI{
  constructor({api,onChange=()=>{},getGeneration=()=>0}={}){
    Object.assign(this,{api,onChange,getGeneration});this.unlocked=false;this.pending=null;this.serial=0;
    this.dialog=node('dialog','parental-dialog');this.dialog.setAttribute('aria-labelledby','parental-title');this.dialog.setAttribute('aria-describedby','parental-description');
    const form=node('form','parental-panel'),symbol=node('div','parental-symbol','18+'),heading=node('h2','','Conteúdo protegido');heading.id='parental-title';
    const description=node('p','','Digite o PIN de quatro números para liberar o conteúdo adulto nesta sessão.');description.id='parental-description';
    const label=node('label','parental-pin-label','PIN de acesso');this.input=node('input','parental-pin');this.input.type='password';this.input.inputMode='numeric';this.input.pattern='[0-9]{4}';this.input.maxLength=4;this.input.minLength=4;this.input.required=true;this.input.autocomplete='off';this.input.setAttribute('aria-describedby','parental-error');label.append(this.input);
    this.error=node('p','parental-error');this.error.id='parental-error';this.error.setAttribute('role','alert');
    const actions=node('div','parental-actions');this.submit=node('button','button primary','Desbloquear');this.submit.type='submit';const cancel=node('button','button secondary','Voltar');cancel.type='button';cancel.addEventListener('click',()=>{if(!this.submit.disabled)this.dialog.close();});actions.append(cancel,this.submit);form.append(symbol,heading,description,label,this.error,actions);this.dialog.append(form);document.body.append(this.dialog);
    form.addEventListener('submit',event=>{event.preventDefault();void this.#submit();});
    this.dialog.addEventListener('close',()=>{this.input.value='';this.pending?.resolve(false);this.pending=null;});
    this.dialog.addEventListener('cancel',event=>{if(this.submit.disabled)event.preventDefault();});
  }
  allows(item,categories=[]){return this.unlocked||!isAdultItem(item,categories);}
  async refresh(){const serial=this.serial,generation=this.getGeneration();try{const status=await this.api('/api/parental');if(serial===this.serial&&generation===this.getGeneration())this.unlocked=status.unlocked===true;}catch{if(serial===this.serial)this.unlocked=false;}return this.unlocked;}
  reset(){this.serial++;this.unlocked=false;this.input.value='';this.error.textContent='';if(this.dialog.open)this.dialog.close();this.pending?.resolve(false);this.pending=null;}
  unlock(){
    if(this.unlocked)return Promise.resolve(true);if(this.pending)return this.pending.promise;
    let resolve;const promise=new Promise(done=>{resolve=done;});this.pending={promise,resolve};this.error.textContent='';this.input.value='';this.submit.disabled=false;this.dialog.showModal();this.input.focus();return promise;
  }
  async #submit(){
    if(this.submit.disabled||!/^\d{4}$/.test(this.input.value))return;
    const serial=this.serial,generation=this.getGeneration(),pin=this.input.value;this.input.value='';this.submit.disabled=true;this.input.removeAttribute('aria-invalid');
    try{const status=await this.api('/api/parental/unlock',{method:'POST',body:JSON.stringify({pin})});if(serial!==this.serial||generation!==this.getGeneration()||!this.dialog.open)return;this.unlocked=status.unlocked===true;if(!this.unlocked)throw new Error('Não foi possível desbloquear.');const pending=this.pending;this.pending=null;this.dialog.close();try{await this.onChange({unlocked:true});}finally{pending?.resolve(true);}}
    catch(error){if(serial===this.serial&&this.dialog.open){this.error.textContent=error.message||'Não foi possível validar o PIN.';this.input.setAttribute('aria-invalid','true');this.input.focus();}}
    finally{if(serial===this.serial)this.submit.disabled=false;}
  }
  async lock(){this.reset();try{await this.api('/api/parental/lock',{method:'POST',body:'{}'});}finally{await this.onChange({unlocked:false});}}
  renderSettings(container){
    const section=node('section','settings-section parental-settings'),heading=node('h3','','Controle parental'),description=node('p','settings-note',this.unlocked?'O conteúdo adulto está liberado somente nesta sessão.':'O conteúdo adulto fica oculto e bloqueado por padrão. Digite seu PIN para liberar nesta sessão.');
    const action=node('button','button primary',this.unlocked?'Bloquear conteúdo adulto':'Desbloquear conteúdo adulto');action.type='button';const status=node('p','settings-note');status.setAttribute('role','status');
    action.addEventListener('click',async()=>{action.disabled=true;try{if(this.unlocked)await this.lock();else await this.unlock();description.textContent=this.unlocked?'O conteúdo adulto está liberado somente nesta sessão.':'O conteúdo adulto está bloqueado.';action.textContent=this.unlocked?'Bloquear conteúdo adulto':'Desbloquear conteúdo adulto';}catch(error){status.textContent=error.message;}finally{action.disabled=false;}});
    section.append(heading,description,action,status);container.append(section);
  }
}
