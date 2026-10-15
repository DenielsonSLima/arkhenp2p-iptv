function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function expiration(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  const calendar = calendarDate(text);
  if (calendar) return {date:calendar, dateTime:text, calendar:true};
  let time;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (!Number.isFinite(number) || number <= 0) return null;
    time = number >= 1e12 ? number : number * 1000;
  } else {
    // Public sessions contain normalized ISO timestamps. Requiring a timezone
    // avoids treating an ambiguous provider date as a different local instant.
    const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(text);
    if (!match || !calendarDate(match[1])) return null;
    time = Date.parse(text);
  }
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? {date, dateTime:date.toISOString(), calendar:false} : null;
}

/** Format only the expiry supplied by the provider, never an estimated date. */
export function formatAccessValidity(session, {now=Date.now(), locale='pt-BR'}={}) {
  const expires = expiration(session?.account?.expiresAt);
  if (!expires) return {
    label:'Validade do acesso', value:'Não informada', dateTime:'', state:'unknown',
    title:'O provedor não informou a data de validade deste acesso.'
  };
  const current = new Date(now);
  let expired;
  if (expires.calendar) {
    // A date without a time remains that calendar date in every timezone, and
    // is valid for the full indicated day in the user's local calendar.
    const today = `${String(current.getFullYear()).padStart(4,'0')}-${String(current.getMonth()+1).padStart(2,'0')}-${String(current.getDate()).padStart(2,'0')}`;
    expired = expires.dateTime < today;
  } else expired = expires.date.getTime() <= current.getTime();
  const dateOptions = {day:'2-digit', month:'2-digit', year:'numeric', ...(expires.calendar ? {timeZone:'UTC'} : {})};
  const detailOptions = {day:'2-digit', month:'long', year:'numeric', ...(expires.calendar ? {timeZone:'UTC'} : {hour:'2-digit', minute:'2-digit'})};
  const value = new Intl.DateTimeFormat(locale, dateOptions).format(expires.date);
  const detail = new Intl.DateTimeFormat(locale, detailOptions).format(expires.date);
  return {
    label:expired ? 'Acesso expirado' : 'Acesso até', value, dateTime:expires.dateTime,
    state:expired ? 'expired' : 'active',
    title:`${expired ? 'Seu acesso expirou em' : 'Seu acesso é válido até'} ${detail}.`
  };
}
