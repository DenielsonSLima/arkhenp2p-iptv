import {createHash} from 'node:crypto';
import {decodeText, ProviderError} from './provider.mjs';
import {validUpstreamURL} from './upstream.mjs';
import {epgTimestamp} from './wplay-epg.mjs';

export const WPLAY_GAMES_CACHE_MS = 60000;
export const WPLAY_GAMES_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_PREFIX = 'wplay:games:';
const text = (value, limit = 300) => decodeText(typeof value === 'string' || typeof value === 'number' ? value : '').slice(0, limit);
const identity = value => /^[\w-]{1,120}$/.test(String(value ?? '')) ? String(value) : null;
const channelID = value => /^\d{1,12}$/.test(String(value ?? '')) && Number(value) > 0 ? String(Number(value)) : null;

export function gamesRequestOptions({date, timeZone = 'UTC', lang = 'pt'} = {}, now = Date.now()) {
  if (typeof timeZone !== 'string' || timeZone.length > 80) throw invalidRequest();
  try {timeZone = new Intl.DateTimeFormat('en-US', {timeZone}).resolvedOptions().timeZone;}
  catch {throw invalidRequest();}
  if (date === undefined || date === null || date === '') {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(now);
    const part = type => parts.find(value => value.type === type)?.value;
    date = `${part('year')}-${part('month')}-${part('day')}`;
  }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0,4)) < 1000) throw invalidRequest();
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0,10) !== date) throw invalidRequest();
  if (typeof lang !== 'string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(lang)) throw invalidRequest();
  return {date, timeZone, lang};
}
function invalidRequest() {return new ProviderError('Informe uma data, um fuso horário e um idioma válidos para consultar os jogos.', 'WPLAY_GAMES_REQUEST_INVALID', 400);}

export function gamesTimezoneOffset({date, timeZone}) {
  // MatchAllListViewModel.generate31DaysList (11.9.0d, code 0x1a2054)
  // formats the selected day's UTC offset as %s%02d:%02d, not an IANA name.
  // Resolve at local noon to avoid a nonexistent hour on a daylight transition.
  const noon = Date.parse(`${date}T12:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {timeZone, timeZoneName:'longOffset'});
  const offsetAt = time => {
    const zone = formatter.formatToParts(time).find(part => part.type === 'timeZoneName')?.value;
    if (zone === 'GMT') return {text:'+00:00', minutes:0};
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zone || '');
    if (!match) throw invalidRequest();
    return {text:match[1]+match[2]+':'+match[3], minutes:(Number(match[2])*60+Number(match[3]))*(match[1]==='-'?-1:1)};
  };
  const first = offsetAt(noon), localNoon = noon-first.minutes*60000;
  return offsetAt(localNoon).text;
}

export function unavailableGames(options, message = 'O serviço não disponibilizou a agenda de jogos para esta conta.') {
  return {available:false, date:options.date, timeZone:options.timeZone, games:[], message};
}
function team(value, image) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = identity(value.id), name = text(value.name), logo = typeof value.logo === 'string' ? image(value.logo) : '';
  return id || name ? {id:id || '', name, logo} : null;
}
function offsetWallTime(value,timeZoneOffset) {
  // Interpret a bare wall clock only with an explicit format contract. The
  // WPLAY adapter supplies UTC after verifying the same game across offsets.
  if(typeof value!=='string' || typeof timeZoneOffset!=='string')return null;
  const offset=/^([+-])(\d{2}):([0-5]\d)$/.exec(timeZoneOffset),parts=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  if(!offset || Number(offset[2])>23 || !parts || Number(parts[1])<1000 || Number(parts[4])>23)return null;
  const [year,month,day,hour,minute,second]=parts.slice(1).map(part=>Number(part||0));
  const wall=new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if(wall.getUTCFullYear()!==year || wall.getUTCMonth()!==month-1 || wall.getUTCDate()!==day)return null;
  const offsetMinutes=(Number(offset[2])*60+Number(offset[3]))*(offset[1]==='-'?-1:1);
  return new Date(wall.getTime()-offsetMinutes*60000).toISOString();
}
function startTime(value,timeZoneOffset) {
  if (typeof value === 'number' || typeof value === 'string' && /^\d{10,13}(?:\.\d+)?$/.test(value)) {
    const number = Number(value), time = number < 1e12 ? number * 1000 : number;
    return number > 0 && Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? new Date(time).toISOString() : null;
  }
  const time = epgTimestamp(value);
  return time === null ? offsetWallTime(value,timeZoneOffset) : new Date(time).toISOString();
}

// Original APK 11.9.0d classes2.dex ServiceApi.getDateGameList returns
// BaseResponse<List<GameData>>; GameData.teams is List<Team> and .channels is
// List<ChannelBean>. Do not copy playback addresses or provider session fields.
export function normalizeWplayGames(payload, {image = () => '',timeZoneOffset} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProviderError('O serviço retornou uma agenda de jogos inválida.', 'WPLAY_INVALID_GAMES', 502);
  }
  if(payload.code!==undefined && payload.code!==0 && payload.code!==200)
    throw new ProviderError('O serviço recusou a consulta da agenda de jogos. Tente novamente.', 'WPLAY_GAMES_REJECTED', 502);
  if(!Array.isArray(payload.data))throw new ProviderError('O serviço retornou uma agenda de jogos inválida.', 'WPLAY_INVALID_GAMES', 502);
  const games = [], seen = new Set();
  for (const raw of payload.data) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = identity(raw.id);if (!id || seen.has(id)) continue;
    seen.add(id);
    const teams = Array.isArray(raw.teams) ? raw.teams.map(value => team(value,image)) : [];
    const channels = [], channelSeen = new Set();
    for (const channel of Array.isArray(raw.channels) ? raw.channels : []) {
      const id = channelID(channel?.chid ?? channel?.id);
      if (!id || channelSeen.has(id)) continue;
      channelSeen.add(id);
      const name = channel?.name;
      channels.push({id, name:text(name && typeof name === 'object' ? name.init ?? name.i18n?.en : name)});
    }
    games.push({id, title:text(raw.name), league:team(raw.league,image), start:startTime(raw.date,timeZoneOffset),
      status:text(raw.status,80), homeTeam:teams[0] || null, awayTeam:teams[1] || null,
      score:text(raw.score,80), channels});
  }
  return games;
}

export async function wplayGames(client, value, tokenURL) {
  const options = gamesRequestOptions(value), base = client.authInfo?.service?.football_url;
  if (typeof base !== 'string' || !base.trim()) return unavailableGames(options);
  let endpoint,timeZoneOffset;
  try {
    const url = validUpstreamURL(base,client.allowPrivate);
    // ue.b.invokeSuspend, code item 0x22a084, appends /games to the configured
    // football base. Retrofit @Query names are date, timezone and lang.
    url.pathname = url.pathname.replace(/\/$/, '') + '/games';url.hash = '';
    timeZoneOffset=gamesTimezoneOffset(options);
    const query = new URLSearchParams({date:options.date, timezone:timeZoneOffset, lang:options.lang});
    endpoint = validUpstreamURL(tokenURL(url.href + (url.search ? '&' : '?') + query, client.authInfo?.service?.token),client.allowPrivate).href;
  } catch {throw new ProviderError('O serviço não disponibilizou um endereço válido para a agenda de jogos.', 'WPLAY_GAMES_UNAVAILABLE', 502);}
  const key = CACHE_PREFIX + createHash('sha256').update(endpoint).digest('hex');
  // Keep a small per-client cache, including simultaneous requests for one day.
  for (const entry of [...client.cache.keys()].filter(name => name.startsWith(CACHE_PREFIX)).slice(0,-11)) client.cache.delete(entry);
  return client.memo(key, async () => {
    let payload;
    try {payload = await client.requestJSON(endpoint, {maxBytes:WPLAY_GAMES_MAX_BYTES});}
    catch (error) {throw new ProviderError('Não foi possível carregar os jogos do serviço agora. Tente novamente.', 'WPLAY_GAMES_UNAVAILABLE', error?.status === 401 ? 401 : 502);}
    // Game 8620559 retained "2026-10-15 13:40" for both timezone=UTC and
    // timezone=-03:00 in the authenticated probe. timezone chooses the day
    // window; it does not localize this UTC date field.
    const image=value=>client.sportsLogos?.queue(value,{scope:client.config?.server,allowPrivate:client.allowPrivate,headers:client.upstreamHeaders?.(value)})||client.image(value);
    return {available:true, date:options.date, timeZone:options.timeZone, games:normalizeWplayGames(payload, {image,timeZoneOffset:'+00:00'})};
  }, WPLAY_GAMES_CACHE_MS);
}
