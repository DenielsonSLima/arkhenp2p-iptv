import {measuredQualityLabel} from '../../channel-variants.js';

/** Resolution belongs to the current decoded video, independently of its name. */
export function livePlaybackMetadata({current, video, channelNumber} = {}) {
  const number = Number(channelNumber ?? current?.channelNumber);
  const channel = Number.isSafeInteger(number) && number > 0 ? String(number).padStart(3, '0') : '';
  const width = video?.videoWidth, height = video?.videoHeight;
  if (current?.mediaMetadataReady && video?.readyState >= 2
    && Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
    return {channel, resolution: measuredQualityLabel(height, width), measured: true,
      description: `Resolução medida do vídeo: ${width} × ${height}`};
  }
  return {channel, resolution: '—', measured: false, description: 'Aguardando a resolução do vídeo atual.'};
}
