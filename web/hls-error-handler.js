import {playbackAPIError,playbackRateLimit} from './playback-api-error.js';
import {liveRateLimitRecovery} from './live-rate-limit-recovery.js';

// Every side effect belongs to one HLS instance. Recording diagnostics may
// synchronously select another source; an old callback must then stop here.
export function createHlsErrorHandler({isCurrent, tools, video, fail, canUseNative, useNative}) {
  const rateLimit=liveRateLimitRecovery({isCurrent,tools,fail});
  return (_, data) => {
    if (!isCurrent() || !data) return;
    const status = Number(data.response?.code ?? data.response?.status ?? data.networkDetails?.status);
    const service = playbackAPIError(data);
    const limited=rateLimit?playbackRateLimit(data):null;
    if (![401, 403].includes(status) && !service && !data.fatal && !limited) return;
    // Telemetry can immediately evaluate adaptive source changes. Mark the
    // cooldown before it runs so a 429 cannot create another live generation.
    if(limited&&tools.current)tools.current.rateLimitedUntil=Date.now()+(limited.retryAfterMs??35000);
    tools.recordError(data);
    if (!isCurrent()) return;
    if (status === 401 || status === 403) {
      fail('Sua conexão precisa ser restabelecida. Entre novamente ou tente retomar a sessão.'); return;
    }
    if(limited){rateLimit.handle(limited);return;}
    if (service) { fail(service.message, {terminalService:true}); return; }
    if(rateLimit?.waiting())return;
    if(tools.trySourceFallback?.('source-error',{status,code:service?.code}))return;
    const recovering = tools.recoverError(data);
    if (!isCurrent() || recovering) return;
    const codec = ['manifestIncompatibleCodecsError','bufferAddCodecError','bufferAppendError','fragParsingError'].includes(data.details);
    const interrupted = data.type === 'networkError' && (tools.current?.segments || 0) >= 1 && video.videoWidth > 0;
    if ((data.type === 'mediaError' || codec || interrupted) && canUseNative()) {
      if (isCurrent()) useNative({interrupted}); return;
    }
    const playlist = ['manifestLoadError','manifestLoadTimeOut','levelLoadError','levelLoadTimeOut'].includes(data.details);
    const segment = ['fragLoadError','fragLoadTimeOut'].includes(data.details);
    fail(data.type === 'networkError' && !codec
      ? (playlist ? 'A lista de reprodução não respondeu após as tentativas de recuperação.'
        : segment ? 'O próximo trecho do vídeo não respondeu após as tentativas de recuperação.'
          : 'A transmissão não respondeu após as tentativas de recuperação.') + ' Tente novamente ou escolha outra fonte disponível.'
      : 'O navegador não conseguiu decodificar esta transmissão. Tente outra fonte disponível ou confira a compatibilidade do formato.');
  };
}
