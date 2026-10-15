import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {materializeP2PInstallPlan,loadP2PInstallPlan} from '../tools/p2p-install-plan.mjs';
const publicManifest=JSON.parse(await readFile(new URL('../tools/p2p-install-artifacts.json',import.meta.url),'utf8'));
test('a fresh Windows clone materializes only its own paths from public pinned sources without any private plan',async()=>{
 const root='C:\\Clone em outro PC\\arkhen',result=await loadP2PInstallPlan(root,{platform:'win32',arch:'x64',read:async file=>{if(file.includes('.local'))throw Object.assign(new Error('not found'),{code:'ENOENT'});return JSON.stringify(publicManifest);}});
 assert.equal(result.source,'versioned-public-artifact-manifest');assert.equal(result.workspace,root);assert.equal(result.artifacts.find(value=>value.id==='cpython-base').destination,path.win32.join(root,'native-bridge','debug-runtime','python-base'));assert.equal(result.artifacts.find(value=>value.id==='jdk').destination,path.win32.join(root,'native-bridge','debug-runtime','jdk'));assert.equal(result.artifacts.find(value=>value.id==='android-commandline-tools').checksums.sha256.length,64);
 assert.doesNotMatch(JSON.stringify(publicManifest),/C:\\|AGRISUL|Desktop|gateway.*key|service_role/);
});
test('materialization rejects traversal, unsupported host and absolute source paths, and ignores a stale plan from another workspace',async()=>{
 const invalid=structuredClone(publicManifest);invalid.hosts[0].artifacts[0].destinationRelative='native-bridge/debug-runtime/../../outside';assert.throws(()=>materializeP2PInstallPlan(invalid,{root:'C:\\clone',platform:'win32',arch:'x64'}),{code:'P2P_INSTALL_MANIFEST_PATH_INVALID'});
 assert.throws(()=>materializeP2PInstallPlan(publicManifest,{root:'C:\\clone',platform:'win32',arch:'unsupported'}),{code:'P2P_INSTALL_HOST_NOT_PINNED'});
 const result=await loadP2PInstallPlan('C:\\clone',{platform:'win32',arch:'x64',read:async file=>JSON.stringify(file.includes('.local')?{workspace:'C:\\another-PC'}:publicManifest)});assert.equal(result.workspace,'C:\\clone');assert.equal(result.source,'versioned-public-artifact-manifest');
});
