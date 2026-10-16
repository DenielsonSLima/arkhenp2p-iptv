/** Provider authentication stays behind the existing same-origin server. */
export class LoginServices{
  constructor({request}={}){if(typeof request!=='function')throw new TypeError('Login requer o transporte da aplicação.');this.request=request;}
  login(value,{signal}={}){return this.request('/api/login',{method:'POST',body:JSON.stringify(value),signal});}
  session({signal}={}){return this.request('/api/session',{signal});}
  logout({signal}={}){return this.request('/api/logout',{method:'POST',body:'{}',signal});}
}
