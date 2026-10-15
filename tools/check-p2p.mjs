#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import {access,statfs} from 'node:fs/promises';
import {createReadStream,constants as fsConstants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolveRuntimePaths,absoluteRuntimePath,pythonProcessEnvironment,runtimeProcessEnvironment} from './p2p-runtime-paths.mjs';

const exec=promisify(execFile),GiB=1024**3;
export const EXPECTED_APK_SHA256='2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69';
export const FRIDA_VERSION='17.8.0';
const windowsQuery=`$ErrorActionPreference='Stop'
function Read-Optional($action){try{& $action}catch{$null}}
$computer=Read-Optional {Get-CimInstance Win32_ComputerSystem | Select-Object SystemType,HypervisorPresent,TotalPhysicalMemory}
$processor=Read-Optional {Get-CimInstance Win32_Processor | Select-Object Name,AddressWidth,VMMonitorModeExtensions,VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions}
$features=Read-Optional {Get-CimInstance Win32_OptionalFeature -Filter "Name='HypervisorPlatform' OR Name='VirtualMachinePlatform'" | Select-Object Name,InstallState}
[pscustomobject]@{computer=$computer;processor=$processor;features=@($features)} | ConvertTo-Json -Depth 5 -Compress`;
const pathsFor=platform=>platform==='win32'?path.win32:path.posix;
const present=async(file,exists)=>{try{await exists(file);return true;}catch{return false;}};

/** A proposal only: no acceptance of licenses, package downloads, OS changes,
 * AVD creation, APK installation, Android process start or account inspection. */
export function p2pPreparationPlan({platform,arch,runtime}){
  const paths=pathsFor(platform),abi=arch==='arm64'?'arm64-v8a':'x86_64';
  const hostSupported=(['win32','linux'].includes(platform)&&arch==='x64')||(platform==='darwin'&&['x64','arm64'].includes(arch));
  return {hostSupported,compatibility:'requires-real-engine-verification',
    sdkRoot:paths.join(runtime,'android-sdk'),avdHome:paths.join(runtime,'avd'),androidUserHome:paths.join(runtime,'android-user'),
    systemImage:`system-images;android-30;google_apis;${abi}`,guestABI:abi,
    packages:['platform-tools','emulator',`system-images;android-30;google_apis;${abi}`],
    java:{version:21,purpose:'SDK manager and AVD preparation; no APK rebuild required',portableDirectory:paths.join(runtime,'jdk')},
    python:{version:'3.x',frida:FRIDA_VERSION,portableDirectory:paths.join(runtime,'python')},
    androidFrida:{version:FRIDA_VERSION,architecture:abi==='x86_64'?'android-x86_64':'android-arm64'},
    acceleration:platform==='win32'?'WHPX':platform==='darwin'?'Hypervisor.Framework':'KVM',
    storageBudgetGiB:16,storageBudgetIsEstimate:true,memoryBudgetGiB:16,memoryBudgetIsEstimate:true,
    armTranslation:arch==='x64',
    license:{accepted:false,automaticAcceptance:false,developmentAndDebugOnly:true,
      terms:'https://developer.android.com/studio/terms',
      imageTerms:'https://android.googlesource.com/platform/prebuilts/android-emulator-build/system-images/+/dd5fdd791f3894ff0b8fdd0095a7890a2235ed77%5E%21/'},
    externalAndroid:{requiresEmulator:false,status:'manual-prepared-loopback-transport-only',
      requirements:['Authorized ARM64 Android device and unchanged supported APK','Prepared root/debug attachment and matching Frida server; stock non-root devices are not supported by this observer',
        'Explicit USB ADB forwarding to loopback Frida and media ports','Same account verified by OriginalEngineBridge'],
      automaticDeviceSelection:false,stockPhoneSupport:false},
    actions:['Review SDK and system-image licenses before download','Prepare SDK and JDK inside the isolated runtime',
      'Prepare a private Python environment with the exact Frida version','Build the local Java bridge bundles',
      'Check emulator acceleration without starting an AVD','Create a fresh isolated debuggable AVD; preserve other AVDs',
      'Verify ARM64 process and native hooks on the unchanged APK before claiming compatibility',
      'Install the exact compatible Frida server only in that isolated AVD','Authenticate in the genuine APK through its own interface',
      'Verify real playlist, media segments and browser playback before enabling the engine']};
}

/** Fixed, bounded system metadata query. stdout/stderr from failed commands and
 * the process environment never enter the report. */
export async function readHostFacts({platform=process.platform,env=process.env,run=exec,kvmAccess=access}={}){
  if(platform==='win32'){
    const systemRoot=env.SystemRoot||env.SYSTEMROOT||'C:\\Windows';
    const executable=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    try{
      const result=await run(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsQuery,'utf16le').toString('base64')],
        {timeout:15000,maxBuffer:65536,windowsHide:true,env:pythonProcessEnvironment({platform,env})});
      const value=JSON.parse(result.stdout),computer=value.computer||{},processors=Array.isArray(value.processor)?value.processor:[value.processor].filter(Boolean),processor=processors[0]||{};
      const features=new Map((Array.isArray(value.features)?value.features:[]).filter(Boolean).map(row=>[row.Name,row.InstallState]));
      const featureState=name=>({1:'enabled',2:'disabled',3:'absent',4:'unknown'}[features.get(name)]||'unknown');
      return {status:value.computer?'observed':'unavailable',hypervisorPresent:typeof computer.HypervisorPresent==='boolean'?computer.HypervisorPresent:null,
        firmwareVirtualization:computer.HypervisorPresent===true?'masked-by-running-hypervisor':typeof processor.VirtualizationFirmwareEnabled==='boolean'?(processor.VirtualizationFirmwareEnabled?'enabled':'disabled-or-unavailable'):'unknown',
        whpx:featureState('HypervisorPlatform'),virtualMachinePlatform:featureState('VirtualMachinePlatform')};
    }catch{return {status:'unavailable',whpx:'unknown',firmwareVirtualization:'unknown'};}
  }
  if(platform==='darwin'){
    try{const result=await run('/usr/sbin/sysctl',['-n','kern.hv_support'],{timeout:5000,maxBuffer:4096,env:pythonProcessEnvironment({platform,env})});return {status:'observed',hypervisorFramework:result.stdout.trim()==='1'?'supported':'unavailable'};}catch{return {status:'unavailable',hypervisorFramework:'unknown'};}
  }
  if(platform==='linux'){try{await kvmAccess('/dev/kvm',fsConstants.R_OK|fsConstants.W_OK);return {status:'observed',kvm:'accessible',acceleration:'requires-emulator-accel-check'};}catch{return {status:'observed',kvm:'unavailable-or-not-permitted'};}}
  return {status:'unsupported'};
}

async function hashAPK(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}

export async function checkP2P({root,platform=process.platform,arch=process.arch,env=process.env,home=os.homedir(),exists=access,
  run=exec,hostFacts=readHostFacts,disk=statfs,hashFile=hashAPK,probeTools=false,system=os,now=Date.now}={}){
  const resolved=await resolveRuntimePaths(root,{platform,env,home,exists}),paths=pathsFor(platform),plan=p2pPreparationPlan({platform,arch,runtime:resolved.runtime});
  const suffix=platform==='win32'?'.exe':'',scriptSuffix=platform==='win32'?'.bat':'';
  const java=env.JAVA_HOME?paths.join(absoluteRuntimePath(env.JAVA_HOME,{platform}),'bin','java'+suffix):paths.join(resolved.runtime,'jdk','bin','java'+suffix);
  const image=paths.join(resolved.sdk,'system-images','android-30','google_apis',plan.guestABI);
  const files={adb:resolved.adb,emulator:resolved.emulator,python:resolved.python,java,
    sdkmanager:paths.join(resolved.sdk,'cmdline-tools','latest','bin','sdkmanager'+scriptSuffix),
    avdmanager:paths.join(resolved.sdk,'cmdline-tools','latest','bin','avdmanager'+scriptSuffix),
    systemImage:paths.join(image,'system.img'),avd:paths.join(resolved.avdHome,'Arkhen_Engine_Debug.ini'),
    agentBundle:paths.join(resolved.root,'tools','original-engine','agent.bundle.js'),
    readinessBundle:paths.join(resolved.root,'tools','original-engine','readiness-agent.bundle.js')};
  const components=Object.fromEntries(await Promise.all(Object.entries(files).map(async([name,file])=>[name,{path:file,present:await present(file,exists)}])));
  let apk=null;
  for(const name of ['WPLAYP2P (1).apk','WPLAYP2P.apk']){const file=paths.join(resolved.root,name);if(await present(file,exists)){let sha256=null;try{sha256=await hashFile(file);}catch{}apk={path:file,sha256,expected:sha256===EXPECTED_APK_SHA256};break;}}
  const hardware=await hostFacts({platform,env,run});
  let diskFreeGiB=null;try{const value=await disk(root);diskFreeGiB=Math.floor(Number(value.bavail)*Number(value.bsize)/GiB);}catch{}
  const memoryGiB=Math.round(system.totalmem()/GiB*10)/10,freeMemoryGiB=Math.round(system.freemem()/GiB*10)/10;
  const probes={executed:probeTools,frida:'not-probed',java:'not-probed',acceleration:'not-probed'};
  if(probeTools){
    if(components.python.present){try{const result=await run(resolved.python,['-I','-B','-c','import frida; print(frida.__version__)'],{timeout:10000,maxBuffer:4096,windowsHide:true,env:pythonProcessEnvironment({platform,env})});probes.frida=result.stdout.trim()===FRIDA_VERSION?'compatible':'version-mismatch';}catch{probes.frida='unavailable';}}
    if(components.java.present){try{const result=await run(java,['-version'],{timeout:10000,maxBuffer:4096,windowsHide:true,env:pythonProcessEnvironment({platform,env})});const output=String(result.stderr||result.stdout),version=Number(/version\s+"(\d+)/.exec(output)?.[1]);probes.java=version>=21?'compatible':'version-mismatch';}catch{probes.java='unavailable';}}
    if(components.emulator.present){try{const result=await run(resolved.emulator,['-accel-check'],{timeout:10000,maxBuffer:4096,windowsHide:true,env:runtimeProcessEnvironment(resolved,{env})});probes.acceleration=/accel:\s*0(?:\s|$)/.test(result.stdout)?'available':'unavailable';}catch{probes.acceleration='unavailable';}}
  }
  const missing=Object.entries(components).filter(([,item])=>!item.present).map(([name])=>name);
  const warnings=[];
  if(memoryGiB<plan.memoryBudgetGiB)warnings.push('HOST_RAM_BELOW_PLANNED_BUDGET');
  if(freeMemoryGiB<2)warnings.push('LOW_AVAILABLE_RAM');
  if(diskFreeGiB!==null&&diskFreeGiB<plan.storageBudgetGiB)warnings.push('INSUFFICIENT_ESTIMATED_RUNTIME_DISK_BUDGET');
  if(hardware.whpx==='disabled')warnings.push('WHPX_DISABLED_REQUIRES_SEPARATE_OS_CHANGE');
  if(plan.armTranslation)warnings.push('ARM_TRANSLATION_AND_NATIVE_HOOKS_NOT_VERIFIED');
  if(!plan.hostSupported)warnings.push('HOST_PLATFORM_NOT_IN_PREPARATION_MATRIX');
  if(!apk)warnings.push('ORIGINAL_APK_MISSING');else if(!apk.expected)warnings.push('ORIGINAL_APK_HASH_MISMATCH');
  return {schemaVersion:1,checkedAt:new Date(now()).toISOString(),readOnly:true,downloads:false,osChanges:false,accountAccess:false,
    status:missing.length?'preparation-required':'components-present-engine-unverified',
    host:{platform,arch,os:system.release(),cpu:system.cpus()[0]?.model||'unknown',logicalCPUs:system.cpus().length,memoryGiB,freeMemoryGiB,diskFreeGiB,...hardware},
    components,missing,apk,probes,warnings,plan,
    evidence:{acceleration:'https://developer.android.com/studio/run/emulator-acceleration',armTranslation:'https://developer.android.com/studio/releases/emulator#30-0-0',frida:'https://frida.re/docs/installation/'}};
}

const main=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(main){
  const flags=process.argv.slice(2);
  if(flags.some(value=>!['--json','--probe-tools'].includes(value))){console.error('Usage: node tools/check-p2p.mjs [--json] [--probe-tools]');process.exitCode=1;}
  else try{const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),result=await checkP2P({root,probeTools:flags.includes('--probe-tools')});console.log(JSON.stringify(result,null,2));if(result.missing.length)process.exitCode=2;}
  catch(error){console.error(JSON.stringify({code:error?.code==='P2P_PATH_CONFIGURATION'?'P2P_PATH_CONFIGURATION':'P2P_PREFLIGHT_FAILED'}));process.exitCode=1;}
}
