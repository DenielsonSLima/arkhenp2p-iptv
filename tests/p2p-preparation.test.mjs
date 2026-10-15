import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {SDKLicenseResponder,validatedSDKArtifacts,prepareP2PSDK} from '../tools/prepare-p2p-sdk.mjs';
import {validatedToolArtifacts,prepareP2PTools} from '../tools/prepare-p2p-tools.mjs';
import {localSDKPackageXML} from '../tools/p2p-sdk-metadata.mjs';

const workspace=path.resolve('.'),hash=value=>createHash('sha256').update(value).digest('hex');
function manifest(root,contents='verified zip fixture'){
 const runtime=path.join(root,'native-bridge','debug-runtime'),bytes=Buffer.from(contents);
 return {host:{platform:'win32',architecture:'x64'},artifacts:[
  {id:'jdk',version:'21.0.12.1+1',url:'https://github.com/adoptium/temurin21-binaries/releases/download/test/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',archiveFormat:'zip',sizeBytes:bytes.length,checksums:{sha256:hash(bytes)},destination:path.join(runtime,'jdk')},
  {id:'android-commandline-tools',version:'22.0',url:'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip',archiveFormat:'zip',sizeBytes:bytes.length,checksums:{sha256:hash(bytes)},destination:path.join(runtime,'android-sdk','cmdline-tools','latest')},
  ...[['android-platform-tools','platform-tools_r37.0.1-win.zip',['platform-tools']],['android-emulator','emulator-windows_x64-16428233.zip',['emulator']],['android-system-image','sys-img/google_apis/x86_64-30_r16.zip',['system-images','android-30','google_apis','x86_64']]].map(([id,url,parts])=>({id,version:'fixture',url:'https://dl.google.com/android/repository/'+url,archiveFormat:'zip',sizeBytes:bytes.length,checksums:{sha1:createHash('sha1').update(bytes).digest('hex')},destination:path.join(runtime,'android-sdk',...parts),licenseId:'android-sdk-license'}))
 ]};
}
async function temporary(t){await mkdir(path.join(workspace,'.local'),{recursive:true});const root=await mkdtemp(path.join(workspace,'.local','p2p-preparation-test-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.join(workspace,'.local'));await rm(root,{recursive:true,force:true});});return root;}

test('license consent defaults off and explicit consent accepts only the required license, even with split prompts',()=>{
 const passive=new SDKLicenseResponder();assert.deepEqual(passive.consume('Review licenses that have not been accepted (y/N)?'),['n']);
 const explicit=new SDKLicenseResponder({accept:true});
 assert.deepEqual(explicit.consume('Review licenses that have not been accepted (y/N)?'),['y']);
 assert.deepEqual(explicit.consume('\nLicense android-sdk-'),[]);
 assert.deepEqual(explicit.consume('license:\nTerms\nAccept? (y/'),[]);
 assert.deepEqual(explicit.consume('N):'),['y']);
 assert.deepEqual(explicit.consume('\nLicense android-sdk-preview-license:\nAccept? (y/N):'),['n']);
 assert.deepEqual(explicit.consume('\nLicense android-sdk-arm-dbt-license:\nAccept? (y/N):'),['n']);
 assert.deepEqual(explicit.consume('\n'),[]);
});

test('SDK application without the explicit license flag fails before mutation, download or license process',async()=>{
 let licenseCalls=0,networkCalls=0;
 await assert.rejects(prepareP2PSDK({root:workspace,manifest:manifest(workspace),apply:true,acceptLicenses:async()=>{licenseCalls++;},fetchImpl:async()=>{networkCalls++;}}),{code:'P2P_SDK_LICENSE_CONSENT_REQUIRED'});
 assert.equal(licenseCalls,0);assert.equal(networkCalls,0);
 const plan=await prepareP2PSDK({root:workspace,manifest:manifest(workspace)});assert.equal(plan.dryRun,true);assert.equal(plan.accepted,false);
});

test('runtime preparation rejects foreign URLs, non-workspace destinations and mismatched license IDs',()=>{
 for(const [field,value]of [['url','https://private.example/tool.zip'],['destination',path.resolve(workspace,'..','outside')],['licenseId','unrelated-vendor-license']]){
  const valueManifest=manifest(workspace);valueManifest.artifacts.find(row=>row.id==='android-emulator')[field]=value;assert.throws(()=>validatedSDKArtifacts(valueManifest,workspace),{code:'P2P_PREPARATION_MANIFEST'});
 }
 const value=manifest(workspace);value.artifacts[0].checksums.sha256='invalid';assert.throws(()=>validatedToolArtifacts(value,workspace),{code:'P2P_PREPARATION_MANIFEST'});
});

test('bad archive hash blocks all extraction, including concurrent sibling downloads',async t=>{
 const root=await temporary(t);let extracts=0;
 await assert.rejects(prepareP2PTools({root,manifest:manifest(root),apply:true,platform:'win32',arch:'x64',fetchImpl:async()=>new Response('tiny'),unpack:async()=>{extracts++;}}),{code:'P2P_ARCHIVE_SIZE_MISMATCH'});
 assert.equal(extracts,0);
 const wrong=manifest(root);for(const row of wrong.artifacts)row.sizeBytes=3;
 await assert.rejects(prepareP2PTools({root,manifest:wrong,apply:true,platform:'win32',arch:'x64',fetchImpl:async()=>new Response('bad'),unpack:async()=>{extracts++;}}),{code:'P2P_ARCHIVE_CHECKSUM_MISMATCH'});
 assert.equal(extracts,0);
});

test('decoded ZIP bytes determine size/hash under transfer compression and a second preparation reuses receipts',async t=>{
 const root=await temporary(t),body='verified zip fixture';let downloads=0,extracts=0;
 const options={root,manifest:manifest(root,body),apply:true,platform:'win32',arch:'x64',fetchImpl:async()=>{downloads++;return new Response(body,{headers:{'content-encoding':'gzip','content-length':'7'}});},
  unpack:async(file,destination)=>{assert.equal(await readFile(file,'utf8'),body);extracts++;const top=path.join(destination,'fixture','bin');await mkdir(top,{recursive:true});await Promise.all(['java.exe','sdkmanager.bat','avdmanager.bat'].map(name=>writeFile(path.join(top,name),'fixture')));}};
 const first=await prepareP2PTools(options);assert.equal(first.prepared.length,2);assert.equal(extracts,2);assert.equal(downloads,2);assert.equal(first.androidStarted,false);assert.equal(first.licensesAccepted,false);
 const again=await prepareP2PTools(options);assert.ok(again.prepared.every(row=>row.reused));assert.equal(downloads,2);assert.equal(extracts,2);
});

test('SDK downloads can overlap but verified extraction is serialized to bound preparation memory',async t=>{
 const root=await temporary(t);await mkdir(path.join(root,'native-bridge','debug-runtime'),{recursive:true});
 let extracting=0,maximum=0,licenses=0;
 const result=await prepareP2PSDK({root,manifest:manifest(root),apply:true,acceptSDKLicenses:true,platform:'win32',arch:'x64',registerPackage:async()=>{},
  acceptLicenses:async()=>{licenses++;return {accepted:[{id:'android-sdk-license'}]};},fetchImpl:async()=>new Response('verified zip fixture'),
  unpack:async(file,destination)=>{extracting++;maximum=Math.max(maximum,extracting);await new Promise(resolve=>setTimeout(resolve,5));
   const top=path.join(destination,'fixture');await mkdir(top,{recursive:true});const name=file.includes('platform-tools_')?'adb.exe':file.includes('emulator-windows_')?'emulator.exe':'system.img';await writeFile(path.join(top,name),'fixture');extracting--;}});
 assert.equal(licenses,1);assert.equal(maximum,1);assert.equal(result.prepared.length,3);assert.equal(result.androidStarted,false);assert.equal(result.reboot,false);
});

test('emulator local registration retains the exact official revision/license and cannot silently select a newer archive',()=>{
 const source=`<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:generic="http://schemas.android.com/repository/android/generic/02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><license id="android-sdk-license" type="text">Fixture license text</license><remotePackage path="emulator"><type-details xsi:type="generic:genericDetailsType"/><revision><major>37</major><minor>2</minor><micro>12</micro></revision><display-name>Android Emulator</display-name><uses-license ref="android-sdk-license"/><channelRef ref="channel-0"/><archives><archive>Never part of installed metadata</archive></archives></remotePackage></sdk:sdk-repository>`;
 const local=localSDKPackageXML(source,{packagePath:'emulator',version:'37.2.12'});
 assert.match(local,/<localPackage path="emulator">/);assert.match(local,/<major>37<\/major>/);assert.match(local,/<uses-license ref="android-sdk-license"/);assert.doesNotMatch(local,/remotePackage|<archives>|channelRef/);
 assert.throws(()=>localSDKPackageXML(source,{packagePath:'emulator',version:'37.3.4'}),{code:'P2P_SDK_METADATA_REVISION'});
 assert.throws(()=>localSDKPackageXML('<!DOCTYPE bad>'+source,{packagePath:'emulator',version:'37.2.12'}),{code:'P2P_SDK_METADATA_INVALID'});
});
