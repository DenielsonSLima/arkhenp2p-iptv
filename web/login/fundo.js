export const LOGIN_BACKDROP='/assets/brand/login-collage.jpg';

/** Own only the login atmosphere; preserve the existing artwork and CSS. */
export class LoginBackdrop{
  constructor(root){
    this.root=root;this.created=[];const document=root.ownerDocument;let previous=null;
    for(const className of ['login-background','login-gradient']){
      let element=root.querySelector('.'+className);
      if(!element){element=document.createElement('div');element.className=className;element.setAttribute('aria-hidden','true');root.insertBefore(element,previous?previous.nextSibling:root.firstChild);this.created.push(element);}
      if(className==='login-background')this.background=element;
      previous=element;
    }
    this.previousImage=this.background.style.backgroundImage;this.background.style.backgroundImage=`url("${LOGIN_BACKDROP}")`;
  }
  setVisible(visible){this.root.ownerDocument.body.classList.toggle('login-active',visible===true);}
  dispose(){this.setVisible(false);this.background.style.backgroundImage=this.previousImage;for(const element of this.created)element.remove();this.created=[];}
}
