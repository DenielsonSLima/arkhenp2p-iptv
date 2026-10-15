import test from 'node:test';
import assert from 'node:assert/strict';
import {absoluteRuntimePath,runtimePythonPath,resolveRuntimePaths,pythonProcessEnvironment,runtimeProcessEnvironment} from '../tools/p2p-runtime-paths.mjs';

const absent=async()=>{throw new Error('absent');};
test('Windows resolves native executable suffixes and its prepared private virtualenv without Mac paths',async()=>{
 const root='C:\\Projetos com espaço\\arkhen',sdk='C:\\Users\\Fixture\\AppData\\Local\\Android\\Sdk';
 const resolved=await resolveRuntimePaths(root,{platform:'win32',env:{LOCALAPPDATA:'C:\\Users\\Fixture\\AppData\\Local'},home:'C:\\Users\\Fixture',exists:async value=>{if(value!==sdk)throw new Error('absent');}});
 assert.equal(resolved.sdk,sdk);assert.equal(resolved.adb,sdk+'\\platform-tools\\adb.exe');assert.equal(resolved.emulator,sdk+'\\emulator\\emulator.exe');assert.equal(resolved.python,root+'\\native-bridge\\debug-runtime\\python\\Scripts\\python.exe');assert.doesNotMatch(JSON.stringify(resolved),/denielson|homebrew|python\/bin/);
});
test('macOS and Linux use their own SDK conventions while a portable project SDK takes priority',async()=>{
 for(const [platform,home,expected]of [['darwin','/Users/fixture','/Users/fixture/Library/Android/sdk'],['linux','/home/fixture','/home/fixture/Android/Sdk']]){
  const resolved=await resolveRuntimePaths('/project',{platform,env:{},home,exists:async value=>{if(value!==expected)throw new Error('absent');}});assert.equal(resolved.sdk,expected);assert.equal(resolved.adb,expected+'/platform-tools/adb');assert.equal(resolved.python,'/project/native-bridge/debug-runtime/python/bin/python3');
  const portable=await resolveRuntimePaths('/project',{platform,env:{},home,exists:async()=>{}});assert.equal(portable.sdk,'/project/native-bridge/debug-runtime/android-sdk');
 }
});
test('explicit absolute overrides win and invalid overrides never fall back to an unrelated installation',async()=>{
 const options={platform:'linux',home:'/home/fixture',exists:absent};
 const resolved=await resolveRuntimePaths('/project',{...options,env:{ARKHEN_ANDROID_SDK:'/chosen sdk',ANDROID_HOME:'/other',ANDROID_SDK_ROOT:'/third',ARKHEN_P2P_ADB:'/tools/adb',ARKHEN_P2P_EMULATOR:'/tools/emulator',ARKHEN_P2P_PYTHON:'/private/python'}});
 assert.equal(resolved.sdk,'/chosen sdk');assert.equal(resolved.adb,'/tools/adb');assert.equal(resolved.emulator,'/tools/emulator');assert.equal(resolved.python,'/private/python');
 assert.equal((await resolveRuntimePaths('/project',{...options,env:{ANDROID_HOME:'/home-sdk',ANDROID_SDK_ROOT:'/root-sdk'}})).sdk,'/home-sdk');
 assert.equal((await resolveRuntimePaths('/project',{...options,env:{ANDROID_SDK_ROOT:'/root-sdk'}})).sdk,'/root-sdk');
 for(const env of [{ARKHEN_ANDROID_SDK:'relative/sdk'},{ARKHEN_P2P_ADB:'adb'},{ARKHEN_P2P_PYTHON:'python3 -m module'},{ARKHEN_P2P_EMULATOR:'/safe\nunsafe'}])await assert.rejects(resolveRuntimePaths('/project',{...options,env}),{code:'P2P_PATH_CONFIGURATION'});
 assert.throws(()=>runtimePythonPath('C:\\project',{platform:'win32',env:{ARKHEN_P2P_PYTHON:'C:\\python.cmd'}}),{code:'P2P_PATH_CONFIGURATION'});
});
test('absolute path checks reject drive-relative and shell text without parsing or executing a command',()=>{
 for(const value of ['C:python.exe','\\python.exe','python.exe','"C:\\Python\\python.exe"','C:\\bad\u0000.exe'])assert.throws(()=>absoluteRuntimePath(value,{platform:'win32'}),{code:'P2P_PATH_CONFIGURATION'});
 assert.equal(absoluteRuntimePath('C:\\Program Files\\Python\\python.exe',{platform:'win32'}),'C:\\Program Files\\Python\\python.exe');
 assert.equal(absoluteRuntimePath('/opt/tools/python;literal',{platform:'linux'}),'/opt/tools/python;literal');
 assert.throws(()=>absoluteRuntimePath('/project',{platform:'unsupported'}),{code:'P2P_PATH_CONFIGURATION'});
});
test('RPC and runtime process environments exclude login/server secrets while preserving isolated Android data and OS essentials',async()=>{
 const env={SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:'C:\\Temp',TMP:'C:\\Temp',USERPROFILE:'C:\\Users\\Fixture',SUPABASE_SERVICE_ROLE_KEY:'private-key',ARKHEN_LOGIN_PASSWORD:'private-password',PYTHONPATH:'C:\\injected',NODE_OPTIONS:'injected',PATH:'C:\\untrusted'};
 const python=pythonProcessEnvironment({platform:'win32',env});assert.equal(python.SystemRoot,'C:\\Windows');assert.equal(python.TEMP,'C:\\Temp');assert.doesNotMatch(JSON.stringify(python),/private|injected|USERPROFILE|untrusted/);
 const paths=await resolveRuntimePaths('C:\\project',{platform:'win32',env,home:'C:\\Users\\Fixture',exists:async()=>{}}),runtime=runtimeProcessEnvironment(paths,{env});
 assert.equal(runtime.ANDROID_AVD_HOME,'C:\\project\\native-bridge\\debug-runtime\\avd');assert.equal(runtime.ADB_SERVER_SOCKET,'tcp:127.0.0.1:5038');assert.equal(runtime.ANDROID_ADB_SERVER_PORT,'5038');assert.doesNotMatch(JSON.stringify(runtime),/private|injected|untrusted/);assert.match(runtime.PATH,/System32/);
});
