import test from 'node:test';
import assert from 'node:assert/strict';
import { access, symlink, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../lib/app-server.mjs';

async function withServer(factory, run) {
  const server=factory({connection:{}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally {server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}

test('static serving accepts a module imported through an alternate Unicode path spelling',async t=>{
  const modulePath=fileURLToPath(new URL('../lib/app-server.mjs',import.meta.url));
  const alternatePath=modulePath.normalize('NFC');
  try { await access(alternatePath); }
  catch {t.skip('This filesystem distinguishes Unicode spellings.');return;}
  const {createApp:alternateApp}=await import(pathToFileURL(alternatePath));
  await withServer(alternateApp,async base=>{
    for(const pathname of ['/','/app.js','/catalog-renderer.js']){
      const response=await fetch(base+pathname);
      assert.equal(response.status,200,`${pathname} must be served through the canonical root.`);
    }
  });
});

test('canonical static root still rejects traversal and sibling prefixes',async()=>{
  await withServer(createApp,async base=>{
    for(const pathname of ['/%2e%2e%2fpackage.json','/%2e%2e%2fweb-sibling%2fpackage.json']){
      assert.equal((await fetch(base+pathname)).status,403,`${pathname} must stay outside the served root.`);
    }
  });
});

test('canonical static root still rejects outside symlinks',async t=>{
  const filename=`.static-path-${randomUUID()}.txt`,link=new URL(`../web/${filename}`,import.meta.url);
  try {await symlink(fileURLToPath(new URL('../package.json',import.meta.url)),fileURLToPath(link));}
  catch(error){
    if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.skip('Windows requires Developer Mode or symlink privileges for this check. Traversal is covered separately.');return;}
    throw error;
  }
  try {
    await withServer(createApp,async base=>{
      assert.equal((await fetch(base+`/${filename}`)).status,403,'A symlink must stay outside the served root.');
    });
  } finally {await unlink(link);}
});
