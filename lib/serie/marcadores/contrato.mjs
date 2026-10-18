export const SKIPDB_DUMP_URL='https://skipdb.tv/api/dump';
export const SKIPDB_LICENSE='ODbL 1.0 + Service Provider Reciprocity';
export const SKIPDB_CACHE_MS=86400000;
export const SKIPDB_MAX_BYTES=64*1024*1024,SKIPDB_MAX_SEGMENTS=250000;
export const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export const failure=code=>Object.assign(new Error('Não foi possível atualizar as marcações abertas do SkipDB.'),{code});
