#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {access,mkdir,mkdtemp,readFile,readdir,rename,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {loadP2PInstallPlan} from './p2p-install-plan.mjs';
import {resolveRuntimePaths,runtimeProcessEnvironment} from './p2p-runtime-paths.mjs';
import {assertPreparationPath,downloadPinnedArchive,extractPinnedZip} from './prepare-p2p-tools.mjs';
import {registerPreparedSDKPackage} from './p2p-sdk-metadata.mjs';

const ids=['android-platform-tools','android-emulator','android-system-image'];
const allowedLicenses=['android-sdk-license'];
const fail=code=>Object.assign(new Error(code),{code});
const present=async file=>{try{await access(file);return true;}catch{return false;}};

/** Explicit consent applies only to the license IDs required by this plan.
 * Unrelated preview/vendor licenses offered by --licenses receive "n". */
export class SDKLicenseResponder{
  constructor({accept=false,allowed=allowedLicenses}={}){this.accept=accept;this.allowed=new Set(allowed);this.text='';this.cursor=0;this.current=null;this.encountered=new Set();}
  consume(chunk){this.text+=chunk;if(this.text.length>1024*1024)throw fail('P2P_SDK_LICENSE_OUTPUT_LIMIT');const answers=[];
    const pattern=/License\s+([A-Za-z0-9_-]+):|Review licenses that have not been accepted\s*\(y\/N\)\?|Accept\?\s*\(y\/N\):/g;pattern.lastIndex=this.cursor;
    for(const match of this.text.matchAll(pattern)){this.cursor=match.index+match[0].length;if(match[1]){this.current=match[1];this.encountered.add(this.current);}else if(match[0].startsWith('Review'))answers.push(this.accept?'y':'n');else answers.push(this.accept&&this.allowed.has(this.current)?'y':'n');}
    return answers;
  }
}

export async function acceptRequiredSDKLicenses({root,accept=false,env=process.env,spawnProcess=spawn,notify=()=>{}}){
  if(!accept)throw fail('P2P_SDK_LICENSE_CONSENT_REQUIRED');
  const resolved=await resolveRuntimePaths(root,{env}),javaHome=path.join(resolved.runtime,'jdk');
  const responder=new SDKLicenseResponder({accept,allowed:allowedLicenses});
  const args=['-Xmx512m','-classpath',path.join(resolved.sdk,'cmdline-tools','latest','lib','sdkmanager-classpath.jar'),'com.android.sdklib.tool.sdkmanager.SdkManagerCli',`--sdk_root=${resolved.sdk}`,'--licenses'];
  await new Promise((resolve,reject)=>{
    let done=false;const child=spawnProcess(path.join(javaHome,'bin','java.exe'),args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...runtimeProcessEnvironment(resolved,{env}),JAVA_HOME:javaHome}});
    const timer=setTimeout(()=>{child.kill();finish(fail('P2P_SDK_LICENSE_TIMEOUT'));},120000);
    const finish=cause=>{if(done)return;done=true;clearTimeout(timer);cause?reject(cause):resolve();};
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{try{for(const answer of responder.consume(chunk.toString('utf8')))child.stdin.write(answer+'\n');}catch(cause){child.kill();finish(cause);}});
    child.once('error',()=>finish(fail('P2P_SDK_LICENSE_PROCESS_FAILED')));child.once('exit',code=>finish(code===0?null:fail('P2P_SDK_LICENSE_PROCESS_FAILED')));
  });
  const accepted=[];
  for(const id of allowedLicenses){let contents;try{contents=await readFile(path.join(resolved.sdk,'licenses',id),'utf8');}catch{throw fail('P2P_SDK_LICENSE_NOT_ACCEPTED');}
    const hashes=contents.split(/\r?\n/).map(value=>value.trim()).filter(value=>/^[a-f0-9]{40}$/.test(value));if(!hashes.length)throw fail('P2P_SDK_LICENSE_NOT_ACCEPTED');accepted.push({id,hashes});}
  const result={acceptedAt:new Date().toISOString(),explicitFlag:true,developmentLocalOnly:true,accepted,unrelatedLicensesAccepted:false,encountered:[...responder.encountered]};
  await writeFile(path.join(root,'.local','p2p-sdk-license-acceptance.json'),JSON.stringify(result,null,2),{mode:0o600});notify({stage:'sdk-licenses-accepted',ids:accepted.map(row=>row.id)});return result;
}

export function validatedSDKArtifacts(manifest,root){
  const runtime=path.join(root,'native-bridge','debug-runtime');
  if(manifest?.host?.platform!=='win32'||manifest?.host?.architecture!=='x64')throw fail('P2P_PREPARATION_HOST');
  return ids.map(id=>{const row=manifest.artifacts?.find(item=>item.id===id);let url;try{url=new URL(row?.url);}catch{throw fail('P2P_PREPARATION_MANIFEST');}
    const relative=id==='android-platform-tools'?['android-sdk','platform-tools']:id==='android-emulator'?['android-sdk','emulator']:['android-sdk','system-images','android-30','google_apis','x86_64'];
    const destination=path.join(runtime,...relative),filename=url.pathname.split('/').at(-1);
    const expected=id==='android-platform-tools'?/^\/android\/repository\/platform-tools_r[\d.]+-win\.zip$/:id==='android-emulator'?/^\/android\/repository\/emulator-windows_x64-\d+\.zip$/:/^\/android\/repository\/sys-img\/google_apis\/x86_64-30_r\d+\.zip$/;
    if(url.protocol!=='https:'||url.hostname!=='dl.google.com'||url.username||url.password||url.port||url.search||url.hash||!expected.test(url.pathname)||row.archiveFormat!=='zip'||!Number.isSafeInteger(row.sizeBytes)||row.sizeBytes<1||row.sizeBytes>2*1024**3||!/^[a-f0-9]{40}$/.test(row.checksums?.sha1)||path.resolve(row.destination)!==path.resolve(destination)||row.licenseId!=='android-sdk-license')throw fail('P2P_PREPARATION_MANIFEST');
    return {...row,filename,destination};});
}

export async function prepareP2PSDK({root,manifest,apply=false,acceptSDKLicenses=false,platform=process.platform,arch=process.arch,notify=()=>{},fetchImpl=fetch,unpack=extractPinnedZip,acceptLicenses=acceptRequiredSDKLicenses,registerPackage=registerPreparedSDKPackage,env=process.env}={}){
  const rows=validatedSDKArtifacts(manifest,root),runtime=path.join(root,'native-bridge','debug-runtime'),cache=path.join(root,'.local','p2p-downloads');
  if(!apply)return {dryRun:true,artifacts:rows.map(({id,version,sizeBytes,destination})=>({id,version,sizeBytes,destination})),licenseConsentRequired:true,accepted:false,androidStarted:false};
  if(platform!=='win32'||arch!=='x64')throw fail('P2P_PREPARATION_HOST');
  if(!acceptSDKLicenses)throw fail('P2P_SDK_LICENSE_CONSENT_REQUIRED');
  await assertPreparationPath(root,runtime);await assertPreparationPath(root,cache);await mkdir(cache,{recursive:true});
  const licenseAcceptance=await acceptLicenses({root,accept:acceptSDKLicenses,env,notify});
  let extractionQueue=Promise.resolve();
  const serialExtraction=job=>{const current=extractionQueue.catch(()=>{}).then(job);extractionQueue=current;return current;};
  const outcomes=await Promise.allSettled(rows.map(async row=>{
    await assertPreparationPath(root,row.destination);
    if(await present(row.destination)){let receipt;try{receipt=JSON.parse(await readFile(path.join(row.destination,'.arkhen-prepared.json'),'utf8'));}catch{}
      if(receipt?.checksums?.sha1!==row.checksums.sha1)throw fail('P2P_PREPARATION_DESTINATION_EXISTS');if(row.id==='android-emulator')await registerPackage(row,{root,fetchImpl});return {id:row.id,version:row.version,destination:row.destination,reused:true};}
    const archive=await downloadPinnedArchive(row,cache,{fetchImpl,notify});
    return serialExtraction(async()=>{
    const stage=await mkdtemp(path.join(runtime,'.prepare-'+row.id+'-')),extraction=path.join(stage,'extracted');
    await assertPreparationPath(root,stage);await unpack(archive,extraction,{env,maxUncompressedBytes:8*1024**3});
    const entries=await readdir(extraction,{withFileTypes:true});if(entries.length!==1||!entries[0].isDirectory())throw fail('P2P_ARCHIVE_LAYOUT');
    const source=path.join(extraction,entries[0].name),required=row.id==='android-emulator'?'emulator.exe':row.id==='android-platform-tools'?'adb.exe':'system.img';
    if(!await present(path.join(source,required)))throw fail('P2P_ARCHIVE_LAYOUT');
    await assertPreparationPath(root,source);await assertPreparationPath(root,row.destination);await mkdir(path.dirname(row.destination),{recursive:true});await rename(source,row.destination);
    await writeFile(path.join(row.destination,'.arkhen-prepared.json'),JSON.stringify({id:row.id,version:row.version,checksums:row.checksums,source:row.url,preparedAt:new Date().toISOString()},null,2),{mode:0o600});
    if(row.id==='android-emulator')await registerPackage(row,{root,fetchImpl});
    notify({id:row.id,stage:'prepared'});return {id:row.id,version:row.version,destination:row.destination,reused:false};
    });
  }));
  const failure=outcomes.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  const result={prepared:outcomes.map(result=>result.value),licenseAcceptance,androidStarted:false,reboot:false};
  await writeFile(path.join(root,'.local','p2p-sdk-preparation-result.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const flags=process.argv.slice(2),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  if(flags.some(flag=>!['--apply','--accept-sdk-licenses'].includes(flag))){console.error('Usage: node tools/prepare-p2p-sdk.mjs [--apply --accept-sdk-licenses]');process.exitCode=1;}
  else try{const result=await prepareP2PSDK({root,manifest:await loadP2PInstallPlan(root),apply:flags.includes('--apply'),acceptSDKLicenses:flags.includes('--accept-sdk-licenses'),notify:event=>console.log(JSON.stringify(event))});console.log(JSON.stringify(result));}
  catch(cause){console.error(JSON.stringify({code:cause?.code?.startsWith('P2P_')?cause.code:'P2P_SDK_PREPARATION_FAILED'}));process.exitCode=1;}
}
