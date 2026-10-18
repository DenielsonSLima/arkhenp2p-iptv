import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from './lib/app-server.mjs';
import { createRuntimeCloud } from './lib/runtime-cloud-config.mjs';
export { createApp, parseRange } from './lib/app-server.mjs';
// Ordinary imports remain disconnected; Vercel uses server-only environment
// configuration and direct local execution retains the private local files.
const executable=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
const hosted=process.env.VERCEL==='1';
const cloud=createRuntimeCloud({executable,onConfigurationError:event=>console.error('[cloud-configuration]',JSON.stringify(event))});
const connection=executable&&!hosted?undefined:hosted&&process.env.IPTV_SERVER&&process.env.IPTV_USERNAME&&process.env.IPTV_PASSWORD?
  {server:process.env.IPTV_SERVER,username:process.env.IPTV_USERNAME,password:process.env.IPTV_PASSWORD}:{};
export const server=createApp({cloud,connection,...(executable?{
  onPlaybackError:event=>console.error('[playback-error]',JSON.stringify(event)),
  onPlaybackTransport:event=>console.info('[tv-transport]',JSON.stringify(event))
}:{})});
// Vercel imports the entrypoint and owns the listener. Direct local execution
// still starts the same server below; importing it never starts a local port.
export default server;
if(executable) {
  const port=Number(process.env.PORT||4173);
  const shutdown=()=>server.shutdown().catch(()=>{console.error('Não foi possível concluir o encerramento do servidor.');process.exitCode=1;});
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  server.on('error',error=>{console.error(`Não foi possível iniciar o servidor local: ${error.code||'erro'}`);process.exitCode=1;void shutdown();});
  server.listen(port,'127.0.0.1',()=>console.log(`ARKEHN P2 IPTV · Cinema e TV\nhttp://localhost:${port}\nCtrl+C para encerrar`));
}
