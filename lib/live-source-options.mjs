// Compatibility entry point. The TV implementation lives in lib/tv/.
// Keep existing consumers on the same module instance and public contract.
export {liveQuality,liveSourceRank,liveSourceEntry,nativeLiveSourceEntries,ottLiveSourceEntries,uniqueLiveSources,selectLiveSource,liveSourceCatalog} from './tv/fontes.mjs';
