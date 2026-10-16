import {isAdultItem} from '../../parental-classification.js';
import {movieID} from '../scope.js';

export const MOVIE_RECOMMENDATION_LIMIT=10;
export const MOVIE_RECOMMENDATION_RANKING_VERSION=2;
export const MOVIE_RECOMMENDATION_IDENTITY_VERSION=2;
const phases=new Set(['precondition','bootstrap','http','rpc','dto','request','service','transport']);
export function recommendationFailure(error){
  const status=Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:null;
  return {code:/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code||'')?error.code:'MOVIE_RECOMMENDATIONS_UNAVAILABLE',
    phase:phases.has(error?.phase)?error.phase:status?'http':'request',...(status?{status}:{}),
    ...(Number.isFinite(error?.retryAfterSeconds)&&error.retryAfterSeconds>=0?{retryAfterSeconds:Math.min(86400,error.retryAfterSeconds)}:{})};
}
export const recommendationUnavailable=error=>Object.assign(new Error('Não foi possível carregar as recomendações agora.'),recommendationFailure(error));
const invalidReply=()=>recommendationUnavailable({phase:'dto'});

/** The RPC owns eligibility, affinity and order. Browser checks only the
 * bounded public DTO and never supplies a loaded-catalog ranking fallback. */
export function recommendationReply(value,id){
  if(value?.schemaVersion!==1||value.rankingVersion!==MOVIE_RECOMMENDATION_RANKING_VERSION||value.identityVersion!==MOVIE_RECOMMENDATION_IDENTITY_VERSION||value.source!=='rpc'||String(value.sourceId)!==id||!Array.isArray(value.items)||value.items.length>MOVIE_RECOMMENDATION_LIMIT)throw invalidReply();
  const seen=new Set();
  for(const candidate of value.items){
    const candidateId=movieID(candidate);
    if(!candidateId||candidateId===id||seen.has(candidateId)||isAdultItem(candidate)||typeof candidate.name!=='string'||!candidate.name.trim())throw invalidReply();
    seen.add(candidateId);
  }
  return value;
}
