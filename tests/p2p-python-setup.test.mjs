import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {pythonSetupPlan,pythonInstallerArguments,downloadPythonArtifact,verifyPythonAuthenticode} from '../tools/setup-p2p-python.mjs';
const root=path.resolve('fixture-setup-project'),base=path.join(root,'native-bridge','debug-runtime','python-base'),venv=path.join(root,'native-bridge','debug-runtime','python');
function manifest(){return {host:{platform:'win32',architecture:'x64'},workspace:root,runtimeDirectory:path.dirname(base),downloadDirectory:path.join(root,'.local','p2p-downloads'),artifacts:[{id:'cpython-base',version:'3.13.16',url:'https://www.python.org/ftp/python/3.13.16/python-3.13.16-amd64.exe',sizeBytes:29935584,checksums:{sha256:'a'.repeat(64)},destination:base},{id:'frida-python-wheel',version:'17.8.0',url:'https://files.pythonhosted.org/packages/aa/bb/ccddee/frida-17.8.0-cp37-abi3-win_amd64.whl',sizeBytes:41897218,checksums:{sha256:'b'.repeat(64)},destination:venv}]};}
test('Python setup permits only pinned official artifacts and exact private destinations for the selected host',()=>{
 const plan=pythonSetupPlan(manifest(),{root,platform:'win32',arch:'x64'});assert.equal(plan.python,path.join(venv,'Scripts','python.exe'));assert.equal(plan.changesPATH,false);assert.equal(plan.reboot,false);
 for(const mutate of [value=>value.artifacts[0].url='https://unknown.example/python.exe',value=>value.artifacts[0].destination=path.resolve(root,'..','outside'),value=>value.artifacts[1].checksums.sha256='bad',value=>value.artifacts[0].version='3.13.0']){const value=manifest();mutate(value);assert.throws(()=>pythonSetupPlan(value,{root,platform:'win32',arch:'x64'}));}
 assert.throws(()=>pythonSetupPlan(manifest(),{root,platform:'linux',arch:'x64'}),{code:'PYTHON_SETUP_HOST_MISMATCH'});
});
test('installer arguments force a private per-user installation without restart, PATH, launcher, associations or shortcuts',()=>{
 const args=pythonInstallerArguments('C:\\Private Python','C:\\Logs\\python.log');for(const value of ['/quiet','/norestart','InstallAllUsers=0','TargetDir=C:\\Private Python','PrependPath=0','AppendPath=0','Include_launcher=0','InstallLauncherAllUsers=0','AssociateFiles=0','Shortcuts=0','Include_freethreaded=0'])assert.ok(args.includes(value));assert.equal(args.some(value=>/password|supabase|gateway/i.test(value)),false);
});
test('artifact download validates actual bytes/hash before publishing and rejects tampered caches',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'arkhen-python-download-')),payload=Buffer.from('synthetic verified installer');
 try{const artifact={id:'fixture',url:'https://www.python.org/fixture',file:path.join(dir,'fixture.exe'),sizeBytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};const fetch=async()=>new Response(payload,{headers:{'content-length':String(payload.length)}});
 assert.equal((await downloadPythonArtifact(artifact,{fetch})).cached,false);assert.deepEqual(await readFile(artifact.file),payload);assert.equal((await downloadPythonArtifact(artifact,{fetch:()=>assert.fail('Verified cache must avoid download.')})).cached,true);
 await assert.rejects(downloadPythonArtifact({...artifact,sha256:'0'.repeat(64)},{fetch}),{code:'PYTHON_ARTIFACT_HASH_MISMATCH'});
 await assert.rejects(downloadPythonArtifact({...artifact,file:path.join(dir,'bad.exe'),sha256:'0'.repeat(64)},{fetch}),{code:'PYTHON_ARTIFACT_HASH_MISMATCH'});assert.deepEqual(await readdir(dir),['fixture.exe']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Authenticode verification requires a valid PSF signer and uses a fixed encoded script with a filtered environment',async()=>{
 let options,args;const execute=async(file,values,settings)=>{args=values;options=settings;return {stdout:JSON.stringify({status:'Valid',subject:'CN=Python Software Foundation, O=Python Software Foundation',thumbprint:'ABCD'})};};
 const result=await verifyPythonAuthenticode('C:\\Private Python\\installer.exe',{env:{SystemRoot:'C:\\Windows',SUPABASE_SERVICE_ROLE_KEY:'private-key',PYTHONPATH:'injected'},execute});assert.equal(result.status,'Valid');assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.doesNotMatch(JSON.stringify(options.env),/private-key|injected/);assert.ok(args.includes('-EncodedCommand'));
 await assert.rejects(verifyPythonAuthenticode('C:\\installer.exe',{execute:async()=>({stdout:JSON.stringify({status:'Valid',subject:'CN=Unknown'})})}),{code:'PYTHON_AUTHENTICODE_INVALID'});
 await assert.rejects(verifyPythonAuthenticode('C:\\installer.exe',{execute:async()=>({stdout:JSON.stringify({status:'NotSigned',subject:'CN=Python Software Foundation'})})}),{code:'PYTHON_AUTHENTICODE_INVALID'});
});

test('release downloads follow only explicitly allowed HTTPS hosts and reject unrelated or credential-bearing redirects',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'arkhen-release-download-')),payload=Buffer.from('verified release');
 try{const artifact={id:'release',url:'https://github.com/frida/frida/releases/download/17.8.0/file.xz',file:path.join(dir,'release.xz'),sizeBytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};let calls=0;const fetch=async()=>++calls===1?new Response('',{status:302,headers:{location:'https://release-assets.githubusercontent.com/official/file.xz'}}):new Response(payload);
 assert.equal((await downloadPythonArtifact(artifact,{fetch,allowedRedirectHosts:['release-assets.githubusercontent.com']})).cached,false);assert.equal(calls,2);
 for(const location of ['https://unknown.example/file.xz','https://user:secret@release-assets.githubusercontent.com/file.xz','http://release-assets.githubusercontent.com/file.xz'])await assert.rejects(downloadPythonArtifact({...artifact,file:path.join(dir,'rejected.xz')},{fetch:async()=>new Response('',{status:302,headers:{location}}),allowedRedirectHosts:['release-assets.githubusercontent.com']}),{code:'PYTHON_ARTIFACT_REDIRECT_REJECTED'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
