import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from './lib/app-server.mjs';
export { createApp, parseRange } from './lib/app-server.mjs';
export const server=createApp();
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||4173);
  server.on('error',error=>{console.error(`Não foi possível iniciar o servidor local: ${error.code||'erro'}`);process.exitCode=1;});
  const shutdown=()=>{void server.shutdown().catch(()=>{console.error('Não foi possível concluir o encerramento local.');process.exitCode=1;});};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  server.listen(port,'127.0.0.1',()=>console.log(`ARKEHN P2 IPTV · Cinema e TV\nhttp://localhost:${port}\nCtrl+C para encerrar`));
}
