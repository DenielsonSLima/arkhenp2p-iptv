import test from 'node:test';
import assert from 'node:assert/strict';
import {formatAccessValidity} from '../web/access-validity.js';

const now = Date.parse('2026-10-14T12:00:00.000Z');
const session = expiresAt => ({connected:true, account:{expiresAt}});

test('access expiry uses the real normalized provider timestamp', () => {
  const expiresAt = '2026-11-30T15:00:00.000Z';
  const result = formatAccessValidity(session(expiresAt), {now});
  assert.equal(result.label, 'Acesso até');
  assert.equal(result.value, new Intl.DateTimeFormat('pt-BR', {day:'2-digit', month:'2-digit', year:'numeric'}).format(new Date(expiresAt)));
  assert.equal(result.dateTime, expiresAt);
  assert.equal(result.state, 'active');
  assert.match(result.title, /Seu acesso é válido até/);
});

test('seconds and milliseconds from provider metadata identify the same expiry', () => {
  const time = Date.parse('2026-11-30T15:00:00.000Z');
  const expected = formatAccessValidity(session(new Date(time).toISOString()), {now});
  for (const value of [time, time/1000, String(time), String(time/1000)]) {
    assert.deepEqual(formatAccessValidity(session(value), {now}), expected);
  }
});

test('expired timestamps remain visible as expired, including their exact boundary', () => {
  for (const expiresAt of ['2026-10-13T12:00:00.000Z', '2026-10-14T12:00:00.000Z']) {
    const result = formatAccessValidity(session(expiresAt), {now});
    assert.equal(result.state, 'expired');
    assert.equal(result.label, 'Acesso expirado');
    assert.equal(result.dateTime, expiresAt);
    assert.match(result.title, /Seu acesso expirou em/);
  }
});

test('missing or malformed expiry does not invent a date or unlimited access', () => {
  const expected = {label:'Validade do acesso', value:'Não informada', dateTime:'', state:'unknown', title:'O provedor não informou a data de validade deste acesso.'};
  for (const value of [undefined, null, '', ' ', 0, '0', -1, Infinity, NaN, true, {}, 'unlimited', 'vitalício', 'not a date', '2026-02-30', '2026-02-30T12:00:00Z', '2026-10-14T12:00:00']) {
    assert.deepEqual(formatAccessValidity(session(value), {now}), expected, String(value));
  }
  assert.deepEqual(formatAccessValidity(null, {now}), expected);
  assert.deepEqual(formatAccessValidity({connected:true}, {now}), expected);
});

test('calendar expiry keeps its date and includes the full local day', () => {
  const expiresAt = '2026-10-14';
  const sameDay = formatAccessValidity(session(expiresAt), {now:new Date(2026,9,14,23,59,59)});
  assert.equal(sameDay.value, '14/10/2026');
  assert.equal(sameDay.dateTime, expiresAt);
  assert.equal(sameDay.state, 'active');
  const nextDay = formatAccessValidity(session(expiresAt), {now:new Date(2026,9,15,0,0,0)});
  assert.equal(nextDay.value, '14/10/2026');
  assert.equal(nextDay.state, 'expired');
  assert.equal(formatAccessValidity(session('2028-02-29'), {now}).state, 'active');
});

test('explicit timezone offsets preserve the expiry instant and locale can change its display', () => {
  const result = formatAccessValidity(session('2026-11-30T12:00:00-03:00'), {now, locale:'en-GB'});
  assert.equal(result.dateTime, '2026-11-30T15:00:00.000Z');
  assert.equal(result.state, 'active');
  assert.equal(formatAccessValidity(session('2026-11-30'), {now, locale:'en-US'}).value, '11/30/2026');
});
