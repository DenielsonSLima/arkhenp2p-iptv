import {CatalogoFilmes} from './catalogo.mjs';
import {MetadadosFilmes} from './metadados.mjs';
import {ServicoRecomendacoesFilmes} from './recomendacoes/servico.mjs';

/** Movie use cases, composed from separate catalog, metadata and suggestions
 * services. Media transport and private library ownership stay shared. */
export class ServicosFilmes{
  constructor({cloudRuntime,catalogSearch}={}){
    this.catalogo=new CatalogoFilmes({cloudRuntime,catalogSearch});
    this.metadados=new MetadadosFilmes();
    this.suggestions=new ServicoRecomendacoesFilmes({cloudRuntime});
  }
  recommendations(state,request,options){return this.suggestions.recommendations(state,request,options);}
}
