import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from './lib/app-server.mjs';
import { SupabaseCloud } from './lib/supabase-cloud.mjs';
import {wireP2PServerShutdown} from './tools/p2p-web-process.mjs';
export { createApp, parseRange } from './lib/app-server.mjs';
// Only the executable opts into reading the local cloud secret. Test callers
// importing createApp remain disconnected from any real Supabase project.
const executable=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
const cloud=executable?new SupabaseCloud():null;
export const server=createApp({cloud,...(executable?{onPlaybackError:event=>console.error('[playback-error]',JSON.stringify(event))}:{})});
if(executable) {
  const port=Number(process.env.PORT||4173);
  const shutdown=wireP2PServerShutdown(server,{onError:()=>{console.error('Não foi possível concluir o encerramento local.');process.exitCode=1;}});
  server.on('error',error=>{console.error(`Não foi possível iniciar o servidor local: ${error.code||'erro'}`);process.exitCode=1;void shutdown();});
  server.listen(port,'127.0.0.1',()=>console.log(`ARKEHN P2 IPTV · Cinema e TV\nhttp://localhost:${port}\nCtrl+C para encerrar`));
}
