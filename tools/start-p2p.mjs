#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { acquireLauncherLock, createRuntime, localPortOpen, runtimeError } from './p2p-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = {
  P2P_ALREADY_RUNNING: 'O iniciador P2P deste projeto já está aberto.',
  P2P_WEB_PORT_BUSY: 'A porta 4173 já está em uso. Encerre somente a instância anterior do servidor ARKHEN e execute novamente.',
  P2P_COMPONENT_MISSING: 'Falta um componente local preparado (emulador, AVD, Python ou bundle). Consulte tools/original-engine/README.md. Nada foi instalado.',
  P2P_APK_MISSING: 'O APK original ainda não está instalado no AVD Arkhen_Engine_Debug.',
  P2P_APK_VERSION: 'O aplicativo instalado precisa ser o WPLAYP2P 11.9.0d original (1190).',
  P2P_WRONG_AVD: 'O emulador 5582 pertence a outro AVD. Nenhum aplicativo dele foi alterado.',
  P2P_AVD_OTHER_PORT: 'O AVD Arkhen_Engine_Debug já está aberto em outra porta. Feche essa instância antes de continuar.',
  P2P_FORWARD_CONFLICT: 'Um encaminhamento ADB necessário pertence a outro dispositivo. Ele foi preservado.',
  P2P_FORWARD_PORT_BUSY: 'Uma porta local necessária já está em uso por outro processo.',
  P2P_FRIDA_MISSING: 'O componente Frida já preparado não foi encontrado dentro deste AVD.',
  P2P_FRIDA_VERSION: 'O cliente e o servidor Frida precisam estar na versão local 17.8.0.',
  P2P_DEBUG_ROOT_REQUIRED: 'Este iniciador exige o AVD de depuração isolado já preparado.',
  P2P_LOGIN_REQUIRED: 'Entre no WPLAY original no AVD Arkhen_Engine_Debug e execute novamente. O iniciador não solicita nem envia sua senha.',
  P2P_ENGINE_NOT_READY: 'A conta está autenticada, mas a engine do aplicativo ainda não ficou pronta.',
  P2P_CANCELLED: 'Inicialização cancelada. O emulador e a sessão salva foram preservados.',
};

let release;
let server;
let requestedSignal;
const controller = new AbortController();
function shutdown(signal) {
  requestedSignal ||= signal;
  controller.abort();
  if (server && server.exitCode === null) server.kill(signal);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
try {
  release = await acquireLauncherLock(path.join(root, '.local/p2p-launcher.lock'));
  if (await localPortOpen(4173)) throw runtimeError('P2P_WEB_PORT_BUSY');
  await createRuntime(root, { signal: controller.signal, notify: message => console.log(message) }).prepare();
  if (controller.signal.aborted) throw runtimeError('P2P_CANCELLED');
  console.log('TV ao vivo pronta. Iniciando o ARKHEN em http://localhost:4173');
  server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PORT: '4173', ARKHEN_ORIGINAL_ENGINE: '1',
      ARKHEN_ORIGINAL_ENGINE_ENDPOINT: '127.0.0.1:27043', ARKHEN_ORIGINAL_ENGINE_MEDIA_PORT: '8904' },
  });
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(runtimeError('P2P_WEB_START_FAILED')));
    server.once('exit', code => { process.exitCode = requestedSignal ? 0 : (code ?? 1); resolve(); });
  });
} catch (error) {
  const code = /^P2P_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'P2P_START_FAILED';
  console.error(`${errors[code] ?? 'Não foi possível preparar a TV local. Consulte o código abaixo e a documentação do projeto.'} (${code})`);
  process.exitCode = requestedSignal ? 0 : 1;
} finally {
  await release?.();
}
