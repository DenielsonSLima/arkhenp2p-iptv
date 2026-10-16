import {LoginScreen} from './tela.js';
import {SessionLoader} from './preparacao.js';
import {LoginBackdrop} from './fundo.js';
import {LoginServices} from './services.js';

/** One local-server login lifecycle. No Supabase client or credentials cache. */
export class LoginOrchestrator{
  constructor({root,startup,request,services,beginConnection=()=>undefined,getGeneration=()=>undefined,
    onSession=()=>{},onConnected=()=>{},beforeShow=()=>{}}={}){
    Object.assign(this,{root,beginConnection,getGeneration,onSession,onConnected,beforeShow});
    this.initialized=false;this.serial=0;this.pending=null;this.disposed=false;
    this.services=services||new LoginServices({request});this.loader=new SessionLoader(startup);
    this.backdrop=new LoginBackdrop(root);this.screen=new LoginScreen({root,onSubmit:body=>this.initialized?this.connect(body):null});
    this.initialized=true;
  }
  #current(ticket){return !this.disposed&&this.pending===ticket&&ticket.serial===this.serial&&ticket.generation===this.getGeneration();}
  configure(metadata){this.screen.configure(metadata);}
  async connect(body){
    if(!this.initialized||this.disposed)return null;
    const generation=this.beginConnection(),ticket={generation,serial:++this.serial};this.pending=ticket;
    const signal=this.loader.start();this.screen.setBusy(true);
    try{
      const session=await this.services.login(body,{signal});if(!this.#current(ticket))return null;
      this.onSession(session);if(!session?.connected)throw new Error(session?.error||'A conexão ainda não está disponível.');
      this.screen.clearPassword();await this.onConnected(session);return this.#current(ticket)?session:null;
    }catch(error){
      if(this.#current(ticket)){this.loader.finish();if(error?.name!=='AbortError')this.screen.setError(error.message||'Não foi possível entrar.');}
      return null;
    }finally{if(this.pending===ticket){this.pending=null;this.screen.setBusy(false);}}
  }
  async restore(){
    if(!this.initialized||this.disposed)return null;
    const ticket={generation:this.getGeneration(),serial:++this.serial};this.pending=ticket;
    const signal=this.loader.start('Reconhecendo sua sessão');
    try{
      const session=await this.services.session({signal});if(!this.#current(ticket))return null;
      this.onSession(session);this.configure(session?.login);
      if(session?.connected)await this.onConnected(session);else this.show(session?.error||'');
      return session;
    }catch(error){if(this.#current(ticket)){this.configure();this.show(error?.message||'Não foi possível reconhecer a sessão.');}return null;}
    finally{if(this.pending===ticket){this.pending=null;this.screen.setBusy(false);}}
  }
  cancel(){this.serial++;this.pending=null;this.loader.finish();this.screen.setBusy(false);}
  show(error=''){
    if(this.disposed)return;
    this.cancel();this.beforeShow();this.root.hidden=false;this.backdrop.setVisible(true);this.screen.setError(error);this.screen.clearPassword();
    this.root.ownerDocument.title='ARKHEN P2 IPTV · Seu universo em cena';
    this.root.ownerDocument.defaultView?.scrollTo({top:0,behavior:'instant'});this.screen.focus();
  }
  hide(){this.root.hidden=true;this.backdrop.setVisible(false);}
  dispose(){if(this.disposed)return;this.cancel();this.disposed=true;this.initialized=false;this.screen.dispose();this.backdrop.dispose();this.loader.dispose();}
}
