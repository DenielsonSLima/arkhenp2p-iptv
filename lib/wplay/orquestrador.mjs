import {ProviderClient,ProviderError} from '../provider.mjs';
import {WplayPlaybackProviderClient} from './conexao/reproducao.mjs';
import {WplayOTTProviderClient} from './ott/provedor.mjs';
import {WPLAY_AUTH_URLS} from './conexao/autenticacao.mjs';
import {wplayProviderAuthenticationOptions} from './conector-supabase.mjs';

/** Selects the existing provider adapter; browser session ownership stays in createApp. */
export class OrquestradorConexaoWplay {
  constructor({allowPrivateUpstream=false,providerFactory,cloud=null}={}){
    this.allowPrivateUpstream=allowPrivateUpstream;
    this.providerFactory=providerFactory;
    this.cloud=cloud;
  }
  resolveConnection(value={},configuration=null){
    const provider=value.provider||'wplay';
    if(!['wplay','wplay-ott','xtream'].includes(provider))throw new ProviderError('Tipo de acesso não reconhecido.','INVALID_CONNECTION',400);
    const server=provider==='wplay'?WPLAY_AUTH_URLS[1]:provider==='wplay-ott'?'https://player.wplayott.com':typeof value.server==='string'&&value.server.trim()?value.server.trim():configuration?.server;
    if(!server)throw new ProviderError('Abra as opções de conexão e informe o servidor do seu serviço IPTV.','INVALID_CONNECTION',400);
    const config={server,username:value.username,password:value.password,...(provider==='wplay'?{authURLs:[WPLAY_AUTH_URLS[1],WPLAY_AUTH_URLS[0]]}:{})};
    const options={
      allowPrivate:this.allowPrivateUpstream,
      // Fixture factories and explicitly private upstreams never start web OTT.
      webPlayback:provider==='wplay'&&!this.allowPrivateUpstream&&!this.providerFactory,
      ...wplayProviderAuthenticationOptions(provider,this.cloud)
    };
    return {provider,config,options};
  }
  async createClient(connection){
    const {provider,config,options}=connection;
    if(this.providerFactory)return this.providerFactory({provider,config,options});
    const Client=provider==='wplay'?WplayPlaybackProviderClient:provider==='wplay-ott'?WplayOTTProviderClient:ProviderClient;
    return new Client(config,options);
  }
}
