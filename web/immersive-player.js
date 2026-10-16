// Compatibility entry point. Canonical UI lives in player/; TV policy in tv/player/.
export {ImmersivePlayer, formatMediaTime, loadingEstimate} from './player/orquestrador.js';
export {numberedChannels, channelNeighbors} from './tv/player/canais.js';
export {parseProgramTime, programWindow} from './program-guide.js';
