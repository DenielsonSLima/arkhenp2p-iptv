import path from 'node:path';
import {homedir} from 'node:os';
import {access} from 'node:fs/promises';

const failure=()=>Object.assign(new Error('P2P_PATH_CONFIGURATION'),{code:'P2P_PATH_CONFIGURATION'});
const pathsFor=platform=>platform==='win32'?path.win32:path.posix;
const supported=platform=>['win32','darwin','linux'].includes(platform);
export function absoluteRuntimePath(value,{platform=process.platform}={}){
  const paths=pathsFor(platform);
  if(!supported(platform)||typeof value!=='string'||!value||/[\x00-\x1f\x7f]/.test(value)||!paths.isAbsolute(value)||platform==='win32'&&!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(value))throw failure();
  return paths.normalize(value);
}
const configured=(env,key,platform)=>env[key]===undefined||env[key]===''?null:absoluteRuntimePath(env[key],{platform});
export function runtimePythonPath(root,{platform=process.platform,env=process.env}={}){
  const paths=pathsFor(platform),base=absoluteRuntimePath(root,{platform});
  const python=configured(env,'ARKHEN_P2P_PYTHON',platform)||paths.join(base,'native-bridge','debug-runtime','python',...(platform==='win32'?['Scripts','python.exe']:['bin','python3']));
  if(platform==='win32'&&!/\.exe$/i.test(python))throw failure();
  return python;
}

/** Discover prepared installations only. No PATH command lookup, downloads,
 * directory creation, process start or changes to another Android installation. */
export async function resolveRuntimePaths(root,{platform=process.platform,env=process.env,home=homedir(),exists=access}={}){
  const paths=pathsFor(platform),base=absoluteRuntimePath(root,{platform}),runtime=paths.join(base,'native-bridge','debug-runtime');
  let sdk;
  for(const key of ['ARKHEN_ANDROID_SDK','ANDROID_HOME','ANDROID_SDK_ROOT']){const value=configured(env,key,platform);if(value){sdk=value;break;}}
  if(!sdk){
    const candidates=[paths.join(runtime,'android-sdk')],userHome=absoluteRuntimePath(home,{platform});
    if(platform==='win32')candidates.push(paths.join(configured(env,'LOCALAPPDATA',platform)||paths.join(userHome,'AppData','Local'),'Android','Sdk'));
    else if(platform==='darwin')candidates.push(paths.join(userHome,'Library','Android','sdk'));
    else candidates.push(paths.join(userHome,'Android','Sdk'),paths.join(userHome,'Android','sdk'));
    for(const candidate of candidates){try{await exists(candidate);sdk=candidate;break;}catch{}}
    sdk||=candidates[0];
  }
  const suffix=platform==='win32'?'.exe':'';
  return {platform,root:base,runtime,sdk,
    adb:configured(env,'ARKHEN_P2P_ADB',platform)||paths.join(sdk,'platform-tools','adb'+suffix),
    emulator:configured(env,'ARKHEN_P2P_EMULATOR',platform)||paths.join(sdk,'emulator','emulator'+suffix),
    python:runtimePythonPath(base,{platform,env}),avdHome:paths.join(runtime,'avd'),androidUserHome:paths.join(runtime,'android-user')};
}

/** Windows Python needs SystemRoot for its platform libraries. Other server
 * environment values (including Supabase keys, login data and PYTHONPATH) never
 * enter the private RPC child. Python also runs with -I. */
export function pythonProcessEnvironment({platform=process.platform,env=process.env}={}){
  const result={PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'};
  const names=platform==='win32'?['SystemRoot','WINDIR','TEMP','TMP']:['TMPDIR'];
  for(const name of names){const key=Object.keys(env).find(key=>key.toLowerCase()===name.toLowerCase());if(key&&typeof env[key]==='string'&&!/[\x00-\x1f\x7f]/.test(env[key]))result[name]=env[key];}
  return result;
}

export function runtimeProcessEnvironment(resolved,{env=process.env}={}){
  const {platform,sdk,adb,emulator,python,avdHome,androidUserHome}=resolved,paths=pathsFor(platform),safe=pythonProcessEnvironment({platform,env});
  for(const name of platform==='win32'?['USERPROFILE']:['HOME','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR'])if(typeof env[name]==='string'&&!/[\x00-\x1f\x7f]/.test(env[name]))safe[name]=env[name];
  const system=platform==='win32'?(safe.SystemRoot?[paths.join(safe.SystemRoot,'System32'),safe.SystemRoot]:[]):platform==='darwin'?['/usr/bin','/bin','/usr/sbin','/sbin']:['/usr/bin','/bin'];
  safe.PATH=[...new Set([paths.dirname(adb),paths.dirname(emulator),paths.dirname(python),...system])].join(paths.delimiter);
  return {...safe,ANDROID_HOME:sdk,ANDROID_SDK_ROOT:sdk,ANDROID_AVD_HOME:avdHome,ANDROID_USER_HOME:androidUserHome,ANDROID_ADB_SERVER_PORT:'5038',ADB_SERVER_SOCKET:'tcp:127.0.0.1:5038'};
}
