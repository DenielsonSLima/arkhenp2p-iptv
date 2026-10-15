import test from 'node:test';
import assert from 'node:assert/strict';
import {checkP2P,p2pPreparationPlan,readHostFacts,EXPECTED_APK_SHA256} from '../tools/check-p2p.mjs';

const GiB=1024**3;
const system={totalmem:()=>8*GiB,freemem:()=>0.6*GiB,release:()=>'10.0.fixture',cpus:()=>[{model:'Synthetic CPU'},{model:'Synthetic CPU'}]};
const fixture=(options={})=>checkP2P({root:'C:\\isolated project',platform:'win32',arch:'x64',home:'C:\\fixture',env:{SystemRoot:'C:\\Windows'},system,
  exists:async()=>{throw new Error('absent');},hostFacts:async()=>({status:'observed',whpx:'disabled',hypervisorPresent:true}),
  disk:async()=>({bavail:124,bsize:GiB}),now:()=>Date.parse('2026-10-15T15:00:00Z'),run:async()=>{throw new Error('No process should start');},...options});

test('preflight reports missing isolated components and a concrete plan without invoking the engine or exposing environment values',async()=>{
  const result=await fixture({env:{SystemRoot:'C:\\Windows',SUPABASE_SECRET_KEY:'do-not-emit-secret',WPLAY_PASSWORD:'do-not-emit-password',PYTHONPATH:'do-not-emit-path'}});
  assert.equal(result.readOnly,true);assert.equal(result.status,'preparation-required');assert.equal(result.downloads,false);assert.equal(result.osChanges,false);assert.equal(result.accountAccess,false);
  assert.equal(result.host.memoryGiB,8);assert.equal(result.host.diskFreeGiB,124);assert.equal(result.host.whpx,'disabled');
  assert.ok(result.missing.includes('readinessBundle'));assert.ok(result.missing.includes('agentBundle'));assert.ok(result.missing.includes('python'));assert.ok(result.missing.includes('avd'));
  assert.equal(result.plan.systemImage,'system-images;android-30;google_apis;x86_64');assert.equal(result.plan.androidFrida.architecture,'android-x86_64');
  assert.equal(result.probes.executed,false);assert.equal(result.plan.license.accepted,false);assert.equal(result.plan.compatibility,'requires-real-engine-verification');
  assert.ok(result.warnings.includes('LOW_AVAILABLE_RAM'));assert.ok(result.warnings.includes('WHPX_DISABLED_REQUIRES_SEPARATE_OS_CHANGE'));
  assert.doesNotMatch(JSON.stringify(result),/do-not-emit|native-bridge-key|supabase\.json|cookie/i);
});

test('complete files and original APK hash still do not claim that native engine playback was verified',async()=>{
  const result=await fixture({exists:async()=>{},hashFile:async()=>EXPECTED_APK_SHA256});
  assert.deepEqual(result.missing,[]);assert.equal(result.apk.expected,true);assert.equal(result.status,'components-present-engine-unverified');
  assert.equal(result.probes.frida,'not-probed');assert.equal(result.probes.acceleration,'not-probed');
});

test('optional version probes use fixed arguments, bounded hidden children and filtered environments, never Android startup or login',async()=>{
  const commands=[];
  const result=await fixture({exists:async()=>{},hashFile:async()=>EXPECTED_APK_SHA256,probeTools:true,
    env:{SystemRoot:'C:\\Windows',JAVA_HOME:'C:\\portable jdk',SUPABASE_SECRET_KEY:'do-not-emit',WPLAY_PASSWORD:'do-not-emit',PYTHONPATH:'do-not-emit'},
    run:async(file,args,options)=>{commands.push({file,args,options});if(file.endsWith('python.exe'))return {stdout:'17.8.0\n'};if(file.endsWith('java.exe'))return {stderr:'openjdk version "21.0.8"\n'};return {stdout:'accel:\n0\nWHPX is installed and usable.\naccel\n'};}});
  assert.equal(commands.length,3);assert.equal(result.probes.frida,'compatible');assert.equal(result.probes.java,'compatible');assert.equal(result.probes.acceleration,'available');
  assert.ok(commands[0].args.includes('-I'));assert.ok(commands[0].args.includes('-B'));assert.deepEqual(commands[2].args,['-accel-check']);
  for(const command of commands){assert.equal(command.options.windowsHide,true);assert.ok(command.options.timeout<=10000);assert.doesNotMatch(JSON.stringify(command.options.env),/do-not-emit|SUPABASE|PASSWORD|PYTHONPATH/);assert.equal(command.options.shell,undefined);}
});

test('failed probes expose only status labels and never subprocess output containing private data',async()=>{
  const result=await fixture({exists:async()=>{},hashFile:async()=>EXPECTED_APK_SHA256,probeTools:true,run:async()=>{throw new Error('private-cookie-or-password');}});
  assert.equal(result.probes.frida,'unavailable');assert.equal(result.probes.java,'unavailable');assert.equal(result.probes.acceleration,'unavailable');assert.doesNotMatch(JSON.stringify(result),/private-cookie-or-password/);
});

test('host plan selects native ARM64 on Apple Silicon and translation on x64 without reusing global AVDs',()=>{
  const mac=p2pPreparationPlan({platform:'darwin',arch:'arm64',runtime:'/isolated/runtime'});
  const linux=p2pPreparationPlan({platform:'linux',arch:'x64',runtime:'/isolated/runtime'});
  assert.equal(mac.armTranslation,false);assert.equal(mac.guestABI,'arm64-v8a');assert.equal(mac.androidFrida.architecture,'android-arm64');assert.equal(mac.acceleration,'Hypervisor.Framework');assert.equal(mac.avdHome,'/isolated/runtime/avd');
  assert.equal(linux.armTranslation,true);assert.equal(linux.acceleration,'KVM');assert.equal(mac.license.automaticAcceptance,false);assert.equal(linux.license.developmentAndDebugOnly,true);
  assert.equal(p2pPreparationPlan({platform:'win32',arch:'arm64',runtime:'C:\\isolated'}).hostSupported,false);
  assert.equal(p2pPreparationPlan({platform:'linux',arch:'arm64',runtime:'/isolated'}).hostSupported,false);
  assert.equal(linux.externalAndroid.requiresEmulator,false);assert.equal(linux.externalAndroid.stockPhoneSupport,false);
});

test('Windows host query distinguishes disabled WHPX from firmware flags masked by a running hypervisor',async()=>{
  let command;
  const result=await readHostFacts({platform:'win32',env:{SystemRoot:'C:\\Windows',SUPABASE_SECRET_KEY:'not-exported'},run:async(file,args,options)=>{command={file,args,options};return {stdout:JSON.stringify({computer:{HypervisorPresent:true},processor:{VirtualizationFirmwareEnabled:false},features:[{Name:'HypervisorPlatform',InstallState:2},{Name:'VirtualMachinePlatform',InstallState:1}]})};}});
  assert.equal(result.firmwareVirtualization,'masked-by-running-hypervisor');assert.equal(result.whpx,'disabled');assert.equal(result.virtualMachinePlatform,'enabled');
  assert.equal(command.options.windowsHide,true);assert.ok(command.args.includes('-NoProfile'));assert.equal(command.file,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');assert.doesNotMatch(JSON.stringify(command.options.env),/not-exported/);
  const script=Buffer.from(command.args.at(-1),'base64').toString('utf16le');assert.doesNotMatch(script,/Enable-|Disable-|Set-|Restart-|Invoke-/);assert.match(script,/Get-CimInstance/);
});

test('denied system metadata stays unknown and Linux permission inspection never starts KVM',async()=>{
  const denied=await readHostFacts({platform:'win32',env:{},run:async()=>{throw new Error('access denied');}});assert.equal(denied.whpx,'unknown');assert.equal(denied.firmwareVirtualization,'unknown');
  const seen=[];const linux=await readHostFacts({platform:'linux',kvmAccess:async(...args)=>{seen.push(args);}});assert.equal(linux.kvm,'accessible');assert.equal(seen[0][0],'/dev/kvm');assert.equal(seen[0][1],6);
});

test('relative Java overrides are rejected rather than launched from the working directory',async()=>{
  await assert.rejects(fixture({env:{JAVA_HOME:'relative-jdk'}}),{code:'P2P_PATH_CONFIGURATION'});
});
