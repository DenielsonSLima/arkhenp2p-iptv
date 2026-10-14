import { performance } from 'node:perf_hooks';

const PROBES = 3;
const SAMPLE_WINDOW_MS = 2 * 60 * 1000;
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const median = values => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

// Only completed segments measure delivery. Playlists and long-lived video
// responses are not substitutes for a bandwidth test or a segment bitrate.
export function summarizeTransfers(transfers, now = Date.now()) {
  const recent = (Array.isArray(transfers) ? transfers : []).filter(sample =>
    sample?.kind === 'segment' && finite(sample.time) && sample.time <= now && now - sample.time <= SAMPLE_WINDOW_MS
  );
  const completed = recent.filter(sample => sample.ok === true && finite(sample.bytes) && sample.bytes > 0 && finite(sample.durationMs) && sample.durationMs > 0);
  const timedMedia = completed.filter(sample => finite(sample.mediaDurationSeconds) && sample.mediaDurationSeconds > 0);
  const bytes = completed.reduce((total, sample) => total + sample.bytes, 0);
  const durationMs = completed.reduce((total, sample) => total + sample.durationMs, 0);
  const mediaBytes = timedMedia.reduce((total, sample) => total + sample.bytes, 0);
  const mediaSeconds = timedMedia.reduce((total, sample) => total + sample.mediaDurationSeconds, 0);
  const mediaDownloadMs = timedMedia.reduce((total, sample) => total + sample.durationMs, 0);
  const ttfb = completed.filter(sample => finite(sample.ttfbMs) && sample.ttfbMs >= 0).map(sample => sample.ttfbMs);
  return {
    throughputMbps: durationMs ? round(bytes * 8 / durationMs / 1000, 3) : null,
    requiredMbps: mediaSeconds ? round(mediaBytes * 8 / mediaSeconds / 1_000_000, 3) : null,
    deliveryRatio: mediaSeconds ? round(mediaDownloadMs / 1000 / mediaSeconds, 3) : null,
    segmentSamples: completed.length,
    upstreamTtfbMs: round(median(ttfb)),
    failedSegments: recent.filter(sample => sample.ok === false).length,
    durationSamples: timedMedia.length
  };
}

function accountNumber(value, positive = false) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && (positive ? number > 0 : number >= 0) ? number : null;
}

function assess(server, stream) {
  if (stream.failedSegments >= 2 || (stream.deliveryRatio !== null && stream.deliveryRatio >= 1)) return {
    status: 'poor', title: 'Entrega abaixo da reprodução',
    detail: stream.failedSegments >= 2 ? 'Houve falhas em segmentos da reprodução recente.' : 'O download dos segmentos levou tanto tempo quanto sua duração de reprodução, ou mais.'
  };
  if (stream.failedSegments || (stream.deliveryRatio !== null && stream.deliveryRatio >= 0.7)) return {
    status: 'fair', title: 'Conexão com pouca margem',
    detail: stream.failedSegments ? 'Um segmento recente falhou; acompanhe a reprodução para confirmar a recuperação.' : 'A entrega dos segmentos está próxima do tempo disponível para reproduzi-los.'
  };
  if (server.successRate === 0 && stream.segmentSamples === 0) return {
    status: 'poor',
    title: server.reachable ? 'Acesso não validado' : 'Servidor sem resposta',
    detail: server.reachable ? 'O servidor respondeu às consultas, mas não validou a conta nesta análise.' : 'As três consultas de metadados falharam nesta análise.'
  };
  if (stream.segmentSamples < 3 || stream.durationSamples < 3) return {
    status: 'insufficient', title: 'Amostra de vídeo insuficiente',
    detail: stream.segmentSamples === 0 ? 'O servidor respondeu, mas ainda não há segmentos de vídeo medidos nesta reprodução.' : 'Há dados de download, mas faltam três segmentos com duração de mídia conhecida para avaliar a margem de reprodução.'
  };
  const apiNote = server.successRate < 1 ? ' Parte das consultas da conta falhou; isso é apresentado separadamente da entrega medida do vídeo.' : server.latencyMs > 1500 || server.jitterMs > 800 ? ' As consultas do catálogo demoraram ou variaram, enquanto os segmentos medidos chegaram a tempo.' : ' As três consultas de metadados responderam.';
  return {
    status: 'good', title: 'Boa margem de reprodução',
    detail: 'Os segmentos recentes chegaram com folga em relação à sua duração de mídia.' + apiNote
  };
}

export async function analyzeConnection(client, { now = Date.now, measureNow = () => performance.now() } = {}) {
  const latencies = [];
  let successful = 0;
  let reachable = false;
  let accountInfo = null;
  for (let probe = 0; probe < PROBES; probe++) {
    const started = measureNow();
    try {
      // An omitted action asks only for authentication/account metadata.
      // This intentionally bypasses the cached client.connect() result.
      const response = await client.api(undefined, {}, { timeout: 8000 });
      const elapsed = Math.max(0, measureNow() - started);
      reachable = true;
      latencies.push(elapsed);
      const info = response?.user_info;
      const expires = Number(info?.exp_date);
      if (info && Number(info.auth) === 1 && (!info.status || String(info.status).toLowerCase() === 'active') && (!Number.isFinite(expires) || expires <= 0 || expires * 1000 > now())) {
        successful++;
        accountInfo = info;
      }
    } catch {
      // Provider errors can contain upstream URLs/credentials; do not return them.
    }
  }
  const checked = now();
  const active = Boolean(client.playback && !client.playback.controller?.signal?.aborted);
  const currentKey = active ? client.playback.key : null;
  const currentTransfers = active && Array.isArray(client.transfers) ? client.transfers.filter(sample => sample.key === currentKey) : [];
  const measurements = summarizeTransfers(currentTransfers, checked);
  const kind = active ? String(currentKey || '').split(':')[0] : null;
  const server = {
    host: new URL(client.config.server).hostname,
    reachable,
    latencyMs: round(median(latencies)),
    jitterMs: latencies.length ? round(Math.max(...latencies) - Math.min(...latencies)) : null,
    successRate: successful / PROBES
  };
  const playback = {
    active,
    kind: ['live', 'movie', 'series'].includes(kind) ? kind : null,
    throughputMbps: measurements.throughputMbps,
    requiredMbps: measurements.requiredMbps,
    deliveryRatio: measurements.deliveryRatio,
    segmentSamples: measurements.segmentSamples,
    upstreamTtfbMs: measurements.upstreamTtfbMs
  };
  const assessment = assess(server, measurements);
  const recommendations = [];
  if (server.successRate === 0) recommendations.push(server.reachable ? 'Confira a situação da assinatura e os dados de acesso no seu provedor.' : 'Confira sua conexão com a internet e tente a análise novamente em alguns minutos.');
  else if (server.successRate < 1) recommendations.push('Repita a análise em alguns minutos para acompanhar as falhas de resposta do servidor.');
  if (measurements.failedSegments || (measurements.deliveryRatio !== null && measurements.deliveryRatio >= 0.7)) recommendations.push('Se houver travamentos, escolha uma versão HD ou SD do mesmo canal, ou um vídeo de menor resolução.');
  if (measurements.segmentSamples < 3 || measurements.durationSamples < 3) recommendations.push(active ? 'Mantenha esta reprodução por cerca de 20 segundos e analise novamente para reunir segmentos reais.' : 'Reproduza um canal por cerca de 20 segundos e analise novamente para medir sua entrega real.');
  if (server.latencyMs > 1500 || server.jitterMs > 800) recommendations.push('As respostas do catálogo variaram; acompanhe a entrega dos segmentos para avaliar a reprodução.');
  const cachedAccount = client.session?.account || {};
  return {
    checkedAt: new Date(checked).toISOString(),
    server,
    playback,
    assessment,
    recommendations,
    account: {
      maxConnections: accountNumber(accountInfo?.max_connections ?? cachedAccount.maxConnections, true),
      activeConnections: accountNumber(accountInfo?.active_cons ?? cachedAccount.activeConnections)
    },
    limits: [
      'A latência e sua variação correspondem a três consultas da API de metadados da conta.',
      'As consultas de análise não abrem outra reprodução nem baixam mídia de teste.',
      'A velocidade é calculada com segmentos da reprodução atual já transferidos nos últimos dois minutos; o bitrate estimado depende da duração informada pelo HLS.',
      'Esta amostra local descreve o período observado e não garante estabilidade futura nem mede a velocidade total do seu plano de internet.'
    ]
  };
}
