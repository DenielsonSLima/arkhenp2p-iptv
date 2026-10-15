import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {p2pAVDPlan,prepareP2PAVD,assertProjectAVDMetadata} from '../tools/prepare-p2p-avd.mjs';
import {AVD} from '../tools/p2p-runtime.mjs';
const root=path.resolve('fixture-p2p-avd');
async function harness({portBusy=false,accel=true,wrongAPK=false,ramGiB=4,existing=false,wrongDevice=false}={}){
 const plan=await p2pAVDPlan(root,{platform:'win32',arch:'x64',env:{},exists:async()=>{}}),files=new Map(),calls=[],writes=[];
 const ini=()=>`path=${plan.avdDirectory}\ntarget=android-30\n`,config='abi.type=x86_64\ntag.id=google_apis\nimage.sysdir.1=system-images/android-30/google_apis/x86_64/\n';
 for(const file of [plan.java,plan.adb,plan.emulator,plan.avdManagerJar,plan.imageFile,plan.licenseFile,plan.apk,plan.fridaServer])files.set(file,'');
 if(existing){files.set(plan.avdIni,ini());files.set(plan.avdDirectory,'directory');files.set(path.join(plan.avdDirectory,'config.ini'),config);}
 let pushed=false;
 const run=async(file,args,options)=>{calls.push({file,args,options});let stdout='';
  if(file===plan.emulator)stdout=accel?'accel:\n0\nWHPX installed and usable.':'accel:\n1\nWHPX unavailable';
  else if(file===plan.java){if(args.includes('create')){files.set(plan.avdIni,ini());files.set(plan.avdDirectory,'directory');files.set(path.join(plan.avdDirectory,'config.ini'),config);stdout='AVD created';}else stdout='tv_1080p\npixel_2\n';}
  else{const command=args.slice(4).join(' ');if(command==='devices')stdout='emulator-5582\tdevice\n';else if(command.endsWith('emu avd name'))stdout=(wrongDevice?'OtherAVD':AVD)+'\nOK';else if(command.endsWith('sys.boot_completed'))stdout='1';else if(command.endsWith('ro.product.cpu.abilist'))stdout='x86_64,arm64-v8a,armeabi-v7a';else if(command.endsWith('ro.product.cpu.abi'))stdout='x86_64';else if(command.endsWith('id -u'))stdout='0';else if(command.includes('push '))pushed=true;else if(command.includes('sha256sum /data/local/tmp/'))stdout=pushed?plan.fridaSHA256+'  /data/local/tmp/arkhen-frida-server':'';}
  return{stdout};
 };
 const options={run,launch:()=>assert.fail('Existing synthetic emulator must be reused without launch.'),portOpen:async()=>portBusy,exists:async file=>files.has(file),fileHash:async file=>file===plan.apk?(wrongAPK?'bad':plan.apkSHA256):plan.fridaSHA256,freeMemory:()=>ramGiB*1024**3,read:async file=>files.get(file),write:async(file,value)=>{writes.push({file,value});files.set(file,value);},makeDir:async()=>{},env:{}};
 return{plan,options,calls,writes,files};
}
test('Main busy, unavailable acceleration, wrong APK and insufficient memory stop before AVD/ADB mutations',async()=>{
 for(const [parameters,code]of [[{portBusy:true},'P2P_WEB_PORT_BUSY'],[{accel:false},'P2P_ACCELERATION_UNAVAILABLE'],[{wrongAPK:true},'P2P_APK_HASH_MISMATCH'],[{ramGiB:1},'P2P_AVAILABLE_RAM_TOO_LOW']]){const f=await harness(parameters);await assert.rejects(prepareP2PAVD(f.plan,f.options),{code});assert.equal(f.calls.some(value=>value.file===f.plan.adb||value.file===f.plan.java),false);assert.deepEqual(f.writes,[]);}
});
test('create-only creates the real TV profile in isolated paths and never starts Android or submits credentials',async()=>{
 const f=await harness();const result=await prepareP2PAVD(f.plan,{...f.options,createOnly:true});assert.equal(result.booted,false);assert.equal(result.created,true);assert.equal(f.calls.some(value=>value.file===f.plan.adb),false);const create=f.calls.find(value=>value.args.includes('create'));assert.ok(create.args.includes('tv_1080p'));assert.ok(create.args.includes('-Dcom.android.sdkmanager.toolsdir='+path.dirname(path.dirname(f.plan.avdManagerJar))));assert.equal(create.options.input,'no\n');assert.equal(create.options.shell,false);assert.equal(create.options.windowsHide,true);assert.equal(create.options.env.ANDROID_AVD_HOME,f.plan.avdHome);assert.doesNotMatch(JSON.stringify(f.calls),/--force|password|input text|force-stop/);
});

test('explicit metadata-only preparation works while Main remains open and never touches ADB or the emulator process',async()=>{
 const f=await harness({portBusy:true,ramGiB:.3}),result=await prepareP2PAVD(f.plan,{...f.options,createOnly:true});assert.equal(result.booted,false);assert.equal(result.webServerChanged,false);assert.equal(result.androidMutations,false);assert.equal(f.calls.some(value=>value.file===f.plan.adb),false);
});
test('matching existing AVD is preserved while the exact APK and Frida are installed only on the owned emulator',async()=>{
 const f=await harness({existing:true}),result=await prepareP2PAVD(f.plan,f.options);assert.equal(result.created,false);assert.equal(result.accountAccess,false);assert.equal(result.fridaServerStarted,false);assert.equal(f.calls.some(value=>value.file===f.plan.java),false);const mutations=f.calls.filter(value=>value.file===f.plan.adb&&value.args.some(arg=>['install','push','chmod','root','am'].includes(arg)));assert.ok(mutations.length>=3);for(const call of mutations)assert.deepEqual(call.args.slice(0,6),['-H','127.0.0.1','-P','5038','-s','emulator-5582']);assert.doesNotMatch(JSON.stringify(f.calls),/uninstall|force-stop|input text|password|"-r"|--force/);
});
test('another device or AVD metadata pointing outside the project is rejected without replacing its app',async()=>{
 const f=await harness({existing:true,wrongDevice:true});await assert.rejects(prepareP2PAVD(f.plan,f.options),{code:'P2P_WRONG_AVD'});assert.equal(f.calls.some(value=>value.args.includes('install')||value.args.includes('push')),false);
 assert.throws(()=>assertProjectAVDMetadata(f.plan,'path=C:\\OtherAVD\ntarget=android-30\n','abi.type=x86_64\ntag.id=google_apis\n'),{code:'P2P_AVD_PATH_MISMATCH'});
});
