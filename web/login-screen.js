// Sign-in behavior is isolated from catalog rendering and playback.
export class LoginScreen {
  constructor({root,onSubmit}) {
    this.root=root;
    this.form=root.querySelector('#login-form');
    this.submit=this.form.querySelector('[type="submit"]');
    this.password=this.form.elements.password;
    this.server=this.form.elements.server;
    this.provider=this.form.elements.provider;
    this.options=root.querySelector('#login-options');
    this.remember=this.form.elements.remember;
    this.error=root.querySelector('#login-error');
    try {const username=localStorage.getItem('arkehn.login.username');if(username){this.form.elements.username.value=username;this.remember.checked=true;}} catch { /* optional storage */ }
    this.form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(this.busy)return;
      const value={username:this.form.elements.username.value.trim(),password:this.password.value,provider:this.provider.value};
      if(value.provider==='xtream'&&this.server.value.trim())value.server=this.server.value.trim();
      try {
        if(this.remember.checked)localStorage.setItem('arkehn.login.username',value.username);
        else localStorage.removeItem('arkehn.login.username');
      } catch { /* credentials are never stored */ }
      await onSubmit(value);
    });
    root.querySelector('#toggle-password').addEventListener('click',()=>{
      const visible=this.password.type==='password';this.password.type=visible?'text':'password';
      const toggle=root.querySelector('#toggle-password');toggle.setAttribute('aria-label',visible?'Ocultar senha':'Mostrar senha');toggle.setAttribute('aria-pressed',String(visible));
    });
    // An invalid advanced field must be visible before the browser focuses it.
    this.server.addEventListener('invalid',()=>{this.options.open=true;});
    this.provider.addEventListener('change',()=>this.updateProvider());
  }
  configure(metadata={}) {
    this.metadata=metadata;this.provider.value=['wplay','wplay-ott','xtream'].includes(metadata.defaultProvider)?metadata.defaultProvider:'wplay';this.updateProvider();
  }
  updateProvider(){
    const xtream=this.provider.value==='xtream';this.server.disabled=!xtream;this.server.required=xtream&&!this.metadata?.configuredServer;
    this.root.querySelector('#login-server-options').hidden=!xtream;
    if(this.server.required)this.options.open=true;
    this.root.querySelector('#login-service-hint').textContent=xtream?'Use os dados de acesso do seu servidor IPTV.':'Use o mesmo usuário e senha do seu WPLAY.';
  }
  setBusy(busy) {
    this.busy=busy;this.form.setAttribute('aria-busy',String(busy));
    for(const element of this.form.querySelectorAll('button,input,select'))element.disabled=busy;
    if(!busy)this.updateProvider();
    this.submit.classList.toggle('is-loading',busy);
    this.submit.querySelector('.login-submit-label').textContent=busy?'Entrando…':'Entrar';
    if(busy)this.error.textContent='';
  }
  clearPassword() {this.password.value='';this.password.type='password';const toggle=this.root.querySelector('#toggle-password');toggle.setAttribute('aria-label','Mostrar senha');toggle.setAttribute('aria-pressed','false');}
  focus() {requestAnimationFrame(()=>{if(this.root.hidden)return;const input=this.form.elements.username;input.focus({preventScroll:true});});}
}
