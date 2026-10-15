#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {access,mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {resolveRuntimePaths,runtimeProcessEnvironment,absoluteRuntimePath} from './p2p-runtime-paths.mjs';
import {AVD,SERIAL,PACKAGE,assertDevice,localPortOpen} from './p2p-runtime.mjs';
import {EXPECTED_APK_SHA256} from './check-p2p.mjs';
const FRIDA_SHA256='af92a84a63f41c97d5b338818b9e77de8392c818f1aeffe4793cdae7fe955e98',IMAGE='system-images;android-30;google_apis;x86_64';
const fail=code=>Object.assign(new Error(code),{code}),present=async file=>{try{await access(file);return true;}catch{return false;}};
const hash=async file=>{const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');};
const fields=input=>Object.fromEntries(String(input).split(/\r?\n/).filter(line=>line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at).trim(),line.slice(at+1).trim()];}));
const samePath=(left,right)=>path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase();
export function assertProjectAVDMetadata(plan,iniText,configText){
  const ini=fields(iniText),config=fields(configText),image=String(config['image.sysdir.1']||'').replace(/\\/g,'/').replace(/\/+$/,'');
  if(!ini.path||!samePath(ini.path,plan.avdDirectory))throw fail('P2P_AVD_PATH_MISMATCH');
  if(config['abi.type']!=='x86_64'||config['tag.id']!=='google_apis'||(config.target||ini.target)!=='android-30'||!(image==='system-images/android-30/google_apis/x86_64'||samePath(image,path.dirname(plan.imageFile))))throw fail('P2P_AVD_IMAGE_MISMATCH');
  return config;
}
function execute(file,args,{input,...options}){return new Promise((resolve,reject)=>{const child=execFile(file,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));if(input!==undefined)child.stdin.end(input);});}
export async function p2pAVDPlan(root,{platform=process.platform,arch=process.arch,env=process.env,exists=access}={}){
  if(platform!=='win32'||arch!=='x64')throw fail('P2P_AVD_HOST_NOT_PREPARED');
  const resolved=await resolveRuntimePaths(root,{platform,env,exists}),java=path.join(env.JAVA_HOME?absoluteRuntimePath(env.JAVA_HOME,{platform}):path.join(resolved.runtime,'jdk'),'bin','java.exe');
  let apk;for(const name of ['WPLAYP2P (1).apk','WPLAYP2P.apk']){const file=path.join(root,name);try{await exists(file);apk=file;break;}catch{}}
  return {...resolved,java,apk:apk||path.join(root,'WPLAYP2P (1).apk'),apkSHA256:EXPECTED_APK_SHA256,
    avdDirectory:path.join(resolved.avdHome,AVD+'.avd'),avdIni:path.join(resolved.avdHome,AVD+'.ini'),
    avdManagerJar:path.join(resolved.sdk,'cmdline-tools','latest','lib','avdmanager-classpath.jar'),
    imageFile:path.join(resolved.sdk,'system-images','android-30','google_apis','x86_64','system.img'),
    licenseFile:path.join(resolved.sdk,'licenses','android-sdk-license'),
    fridaServer:path.join(resolved.runtime,'frida','frida-server-17.8.0-android-x86_64'),fridaSHA256:FRIDA_SHA256,
    avd:AVD,serial:SERIAL,image:IMAGE,package:PACKAGE,mainPortMustBeFree:4173,minimumFreeMemoryGiB:2.5,
    actions:['Require an idle ARKHEN web port and working emulator acceleration','Verify exact original APK and prepared Frida ELF hashes','Create only the isolated project AVD if absent','Boot its visible Android window for manual original-app login','Install the unchanged APK only when absent; preserve matching installed app/session','Install verified Frida only inside this isolated debug AVD','Open the original application; never inspect or submit account credentials'],
    startsWebServer:false,automaticLogin:false,reboot:false};
}

export async function prepareP2PAVD(plan,{createOnly=false,allowRunningWeb=false,run=execute,launch=spawn,portOpen=localPortOpen,exists=present,read=readFile,write=writeFile,makeDir=mkdir,fileHash=hash,freeMemory=os.freemem,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now,notify=()=>{},env=process.env}={}){
  // These checks precede ADB, AVD creation and every Android mutation. The
  // caller must stop its existing web instance itself; this tool never does.
  if(!createOnly&&!allowRunningWeb&&await portOpen(4173))throw fail('P2P_WEB_PORT_BUSY');
  const componentEnv=runtimeProcessEnvironment(plan,{env}),options={timeout:30000,maxBuffer:1024*1024,shell:false,windowsHide:true,env:componentEnv};
  const command=async(file,args,extra={})=>{try{return String((await run(file,args,{...options,...extra})).stdout||'').trim();}catch(error){
    if(file===plan.java||file===plan.emulator){const operation=file===plan.emulator?'accel-check':args.includes('create')?'create-avd':'list-device';const detail=String(error.stderr||error.stdout||'').replace(/https?:\/\/[^\s]+/g,'[official URL]').slice(0,3000);await write(path.join(plan.root,'.local','p2p-avd-command-error.json'),JSON.stringify({operation,exitCode:Number.isInteger(error.code)?error.code:null,systemCode:typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:null,timedOut:error.killed===true,detail},null,2)+'\n').catch(()=>{});}
    throw fail('P2P_PREPARATION_COMMAND_FAILED');}};
  for(const file of [plan.java,plan.adb,plan.emulator,plan.avdManagerJar,plan.imageFile,plan.licenseFile,plan.apk,plan.fridaServer])if(!await exists(file))throw fail('P2P_PREPARATION_COMPONENT_MISSING');
  notify({stage:'checking-acceleration'});const acceleration=await command(plan.emulator,['-accel-check'],{timeout:15000});if(!/accel:\s*0(?:\s|$)/.test(acceleration))throw fail('P2P_ACCELERATION_UNAVAILABLE');
  if(await fileHash(plan.apk)!==EXPECTED_APK_SHA256)throw fail('P2P_APK_HASH_MISMATCH');
  if(await fileHash(plan.fridaServer)!==FRIDA_SHA256)throw fail('P2P_FRIDA_SERVER_HASH_MISMATCH');
  if(!createOnly&&freeMemory()<plan.minimumFreeMemoryGiB*1024**3)throw fail('P2P_AVAILABLE_RAM_TOO_LOW');
  for(const target of [plan.avdHome,plan.androidUserHome,plan.avdDirectory,plan.avdIni]){try{if((await lstat(target)).isSymbolicLink())throw fail('P2P_AVD_PATH_MISMATCH');}catch(error){if(error.code!=='ENOENT')throw error;}}
  await makeDir(plan.avdHome,{recursive:true});await makeDir(plan.androidUserHome,{recursive:true});
  let created=false;
  if(await exists(plan.avdIni)){
    if(!await exists(plan.avdDirectory))throw fail('P2P_AVD_PATH_MISMATCH');
    assertProjectAVDMetadata(plan,await read(plan.avdIni,'utf8'),await read(path.join(plan.avdDirectory,'config.ini'),'utf8'));
  }else{
    if(await exists(plan.avdDirectory))throw fail('P2P_AVD_ORPHANED_DIRECTORY');
    const base=['-Xms32m','-Xmx256m','-Dcom.android.sdkmanager.toolsdir='+path.dirname(path.dirname(plan.avdManagerJar)),'-classpath',plan.avdManagerJar,'com.android.sdklib.tool.AvdManagerCli'];
    notify({stage:'listing-device-profiles'});const deviceIDs=(await command(plan.java,[...base,'list','device','-c'])).split(/\r?\n/).map(value=>value.trim());
    const device=['tv_1080p','tv_720p','pixel_2'].find(value=>deviceIDs.includes(value));if(!device)throw fail('P2P_AVD_DEVICE_PROFILE_UNAVAILABLE');
    notify({stage:'creating-avd-metadata'});await command(plan.java,[...base,'create','avd','--name',AVD,'--package',IMAGE,'--path',plan.avdDirectory,'--device',device],{input:'no\n',timeout:60000});
    if(!await exists(plan.avdIni)||!await exists(path.join(plan.avdDirectory,'config.ini')))throw fail('P2P_AVD_CREATION_INCOMPLETE');
    const file=path.join(plan.avdDirectory,'config.ini'),config=assertProjectAVDMetadata(plan,await read(plan.avdIni,'utf8'),await read(file,'utf8'));
    Object.assign(config,{'hw.ramSize':'1536','hw.cpu.ncore':'2','vm.heapSize':'256','disk.dataPartition.size':'4G'});await write(file,Object.entries(config).map(([key,value])=>`${key}=${value}`).join('\n')+'\n');created=true;
  }
  if(createOnly){const report={status:'isolated-avd-created-not-booted',created,avd:AVD,booted:false,androidMutations:false,accountAccess:false,webServerChanged:false,preparedAt:new Date().toISOString()};await write(path.join(plan.root,'.local','p2p-avd-preparation.json'),JSON.stringify(report,null,2)+'\n');return report;}
  if(!allowRunningWeb&&await portOpen(4173))throw fail('P2P_WEB_PORT_BUSY');
  const prefix=['-H','127.0.0.1','-P','5038'],host=(...args)=>command(plan.adb,[...prefix,...args]),device=(...args)=>command(plan.adb,[...prefix,'-s',SERIAL,...args]);
  const mutate=async(...args)=>{if(!allowRunningWeb&&await portOpen(4173))throw fail('P2P_WEB_PORT_BUSY');if((await device('emu','avd','name')).split(/\r?\n/)[0].trim()!==AVD)throw fail('P2P_WRONG_AVD');return device(...args);};
  await host('start-server');let devices=await host('devices'),avdName;
  if(!devices.split(/\r?\n/).some(line=>line.startsWith(SERIAL+'\t'))){
    for(const line of devices.split(/\r?\n/)){const serial=/^(emulator-\d+)\tdevice(?:\s|$)/.exec(line)?.[1];if(serial&&(await command(plan.adb,[...prefix,'-s',serial,'emu','avd','name'])).split(/\r?\n/)[0].trim()===AVD)throw fail('P2P_AVD_OTHER_PORT');}
    if(await portOpen(5582)||await portOpen(5583))throw fail('P2P_EMULATOR_PORT_BUSY');
    const child=launch(plan.emulator,['-avd',AVD,'-port','5582','-gpu','swiftshader','-no-audio','-no-snapshot','-no-boot-anim'],{cwd:plan.root,shell:false,windowsHide:true,detached:true,stdio:'ignore',env:componentEnv});let failed=false;child.once('error',()=>{failed=true;});child.unref();
    const deadline=now()+120000;while(now()<deadline){if(failed)throw fail('P2P_EMULATOR_START_FAILED');devices=await host('devices');if(new RegExp('^'+SERIAL+'\\tdevice(?:\\s|$)','m').test(devices))break;await sleep(750);}
  }
  avdName=await device('emu','avd','name');if(!assertDevice(devices,avdName))throw fail('P2P_EMULATOR_BOOT_TIMEOUT');
  const deadline=now()+120000;let booted=false;while(now()<deadline){if(await device('shell','getprop','sys.boot_completed')==='1'){booted=true;break;}await sleep(750);}if(!booted)throw fail('P2P_EMULATOR_BOOT_TIMEOUT');
  if(!(await device('shell','getprop','ro.product.cpu.abilist')).split(',').map(value=>value.trim()).includes('arm64-v8a'))throw fail('P2P_ARM64_REQUIRED');
  if(await device('shell','getprop','ro.product.cpu.abi')!=='x86_64')throw fail('P2P_FRIDA_SYSTEM_ABI_MISMATCH');
  let installed='';try{installed=await device('shell','pm','path',PACKAGE);}catch{}
  if(installed){const match=/^package:(\/data\/app\/[A-Za-z0-9_~+./=-]+\/base\.apk)$/.exec(installed);if(!match||(await device('shell','sha256sum',match[1])).split(/\s+/)[0]!==EXPECTED_APK_SHA256)throw fail('P2P_INSTALLED_APK_HASH_MISMATCH');}
  else await mutate('install','--no-streaming',plan.apk);
  if(await device('shell','id','-u')!=='0'){await mutate('root');await device('wait-for-device');if(await device('shell','id','-u')!=='0')throw fail('P2P_DEBUG_ROOT_REQUIRED');}
  const remote='/data/local/tmp/arkhen-frida-server';let remoteHash='';try{remoteHash=(await device('shell','sha256sum',remote)).split(/\s+/)[0];}catch{}
  if(remoteHash&&remoteHash!==FRIDA_SHA256)throw fail('P2P_INSTALLED_FRIDA_HASH_MISMATCH');
  if(!remoteHash){await mutate('push',plan.fridaServer,remote);await mutate('shell','chmod','700',remote);if((await device('shell','sha256sum',remote)).split(/\s+/)[0]!==FRIDA_SHA256)throw fail('P2P_INSTALLED_FRIDA_HASH_MISMATCH');}
  await mutate('shell','am','start','-n',PACKAGE+'/org.bitspark.android.Spark');
  const report={status:'original-app-open-for-manual-login',created,avd:AVD,serial:SERIAL,booted:true,apkHashVerified:true,fridaHashVerified:true,fridaServerStarted:false,accountAccess:false,webServerStarted:false,reboot:false,preparedAt:new Date().toISOString()};
  await write(path.join(plan.root,'.local','p2p-avd-preparation.json'),JSON.stringify(report,null,2)+'\n');notify(report);return report;
}
const main=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(main){const flags=process.argv.slice(2);if(flags.some(flag=>!['--plan','--apply','--create-only','--allow-running-web'].includes(flag))||flags.includes('--plan')&&flags.includes('--apply')||(flags.includes('--create-only')||flags.includes('--allow-running-web'))&&!flags.includes('--apply')){console.error('Usage: node tools/prepare-p2p-avd.mjs [--plan|--apply [--create-only] [--allow-running-web]]');process.exitCode=1;}
else try{const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),plan=await p2pAVDPlan(root);console.log(JSON.stringify(flags.includes('--apply')?await prepareP2PAVD(plan,{createOnly:flags.includes('--create-only'),allowRunningWeb:flags.includes('--allow-running-web'),notify:event=>console.log(JSON.stringify(event))}):plan,null,2));}catch(error){console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(error?.code||'')?error.code:'P2P_AVD_PREPARATION_FAILED'}));process.exitCode=1;}}
