import test from 'node:test';
import assert from 'node:assert/strict';
import { accountLibrarySession } from '../lib/account-library.mjs';

const session = {connected:true, account:{usernameMasked:'••••1234', status:'Active'}};
const connection = {server:'https://provider.example/', username:'first1234', password:'private-password'};
test('library namespace separates real accounts, providers and servers without exposing connection data', () => {
  const first = accountLibrarySession(session,connection,'wplay');
  assert.match(first.account.libraryId,/^[a-f0-9]{64}$/);
  for (const [config,provider] of [[{...connection,username:'other1234'},'wplay'],[connection,'wplay-ott'],[{...connection,server:'https://other.example'},'wplay']]) {
    assert.notEqual(accountLibrarySession(session,config,provider).account.libraryId,first.account.libraryId);
  }
  for (const secret of [connection.username,connection.password,connection.server]) assert.equal(JSON.stringify(first).includes(secret),false);
  assert.equal(session.account.libraryId,undefined);
});
test('library namespace stays stable across passwords, sessions and transient URL credentials', () => {
  const id = accountLibrarySession(session,connection,'xtream').account.libraryId;
  const updated = {...connection,server:'https://user:secret@provider.example/?token=temporary#fragment',password:'changed'};
  assert.equal(accountLibrarySession({...session,account:{...session.account,activeConnections:2}},updated,'xtream').account.libraryId,id);
});
test('disconnected or unidentified accounts do not acquire an invented namespace', () => {
  for (const value of [{connected:false}, {connected:true}]) assert.equal(accountLibrarySession(value,connection),value);
  for (const config of [{...connection,username:''},{...connection,server:'invalid'}]) assert.equal(accountLibrarySession(session,config),session);
});

test('the native WPLAY login suffix identifies the same account while other providers keep distinct usernames',()=>{
  const short={...connection,username:'native-account'},full={...connection,username:'native-account@wareztv.io'};
  assert.equal(accountLibrarySession(session,short,'wplay').account.libraryId,accountLibrarySession(session,full,'wplay').account.libraryId);
  assert.notEqual(accountLibrarySession(session,short,'xtream').account.libraryId,accountLibrarySession(session,full,'xtream').account.libraryId);
});
