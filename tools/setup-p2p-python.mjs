#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,rename,unlink,lstat,access} from 'node:fs/promises';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pythonProcessEnvironment} from './p2p-runtime-paths.mjs';
import {acquireLauncherLock} from './p2p-runtime.mjs';
import {loadP2PInstallPlan} from './p2p-install-plan.mjs';

const run=promisify(execFile),PYTHON='3.13.16',FRIDA='17.8.0';
const fail=code=>Object.assign(new Error(code),{code});
const equalPath=(left,right)=>path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase();
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
const hashFile=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
function owned(root,file){const relative=path.relative(root,file);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw fail('PYTHON_SETUP_PATH_ESCAPE');return file;}
export function pythonInstallerArguments(destination,log){return ['/quiet','/norestart','/log',log,'InstallAllUsers=0','TargetDir='+destination,'PrependPath=0','AppendPath=0','Include_launcher=0','InstallLauncherAllUsers=0','AssociateFiles=0','Shortcuts=0','Include_test=0','Include_doc=0','Include_tcltk=0','Include_tools=0','Include_exe=1','Include_lib=1','Include_dev=1','Include_pip=1','Include_debug=0','Include_symbols=0','Include_freethreaded=0','CompileAll=0'];}
export function pythonSetupPlan(manifest,{root,platform=process.platform,arch=process.arch}={}){
  if(platform!=='win32'||arch!=='x64'||manifest?.host?.platform!==platform||manifest?.host?.architecture!==arch)throw fail('PYTHON_SETUP_HOST_MISMATCH');
  const runtime=path.join(root,'native-bridge','debug-runtime'),base=path.join(runtime,'python-base'),venv=path.join(runtime,'python'),downloads=path.join(root,'.local','p2p-downloads');
  if(!equalPath(manifest.workspace,root)||!equalPath(manifest.runtimeDirectory,runtime)||!equalPath(manifest.downloadDirectory,downloads))throw fail('PYTHON_SETUP_PLAN_PATH_MISMATCH');
  const artifacts=['cpython-base','frida-python-wheel'].map(id=>{
    const item=manifest.artifacts?.find(value=>value.id===id);let url;try{url=new URL(item?.url);}catch{throw fail('PYTHON_SETUP_ARTIFACT_INVALID');}
    const baseArtifact=id==='cpython-base',expected=baseArtifact?base:venv,version=baseArtifact?PYTHON:FRIDA;
    if(item.version!==version||!equalPath(item.destination,expected)||!Number.isSafeInteger(item.sizeBytes)||item.sizeBytes<1||item.sizeBytes>100*1024*1024||!/^[a-f0-9]{64}$/.test(item.checksums?.sha256||'')||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.hostname!==(baseArtifact?'www.python.org':'files.pythonhosted.org')||!(baseArtifact?url.pathname===`/ftp/python/${PYTHON}/python-${PYTHON}-amd64.exe`:/^\/packages\/[a-f0-9/]+\/frida-17\.8\.0-cp37-abi3-win_amd64\.whl$/.test(url.pathname)))throw fail('PYTHON_SETUP_ARTIFACT_INVALID');
    return {id,version,url:url.href,sizeBytes:item.sizeBytes,sha256:item.checksums.sha256,file:owned(root,path.join(downloads,path.basename(url.pathname)))};
  });
  return {schemaVersion:1,host:{platform,arch},root,runtime,base,venv,downloads,basePython:path.join(base,'python.exe'),python:path.join(venv,'Scripts','python.exe'),artifacts,registryScope:'per-user installer registration/cache only',changesPATH:false,installsLauncher:false,changesFileAssociations:false,reboot:false,android:false};
}
async function assertPlainAncestors(root,target){
  owned(root,target);let cursor=root;const parts=path.relative(root,target).split(path.sep).filter(Boolean);
  for(const part of ['',...parts]){if(part)cursor=path.join(cursor,part);try{if((await lstat(cursor)).isSymbolicLink())throw fail('PYTHON_SETUP_SYMLINK_REJECTED');}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export async function downloadPythonArtifact(artifact,{fetch=globalThis.fetch,notify=()=>{},allowedRedirectHosts=[]}={}){
  if(await exists(artifact.file)){if((await lstat(artifact.file)).isSymbolicLink()||await hashFile(artifact.file)!==artifact.sha256)throw fail('PYTHON_ARTIFACT_HASH_MISMATCH');return {cached:true,sha256:artifact.sha256};}
  const temporary=artifact.file+'.part-'+process.pid;let bytes=0;const hash=createHash('sha256');
  try{
    let url=new URL(artifact.url),response;
    for(let redirects=0;redirects<=4;redirects++){
      response=await fetch(url.href,{redirect:'manual',signal:AbortSignal.timeout(180000)});
      if(![301,302,303,307,308].includes(response.status))break;
      const location=response.headers.get('location');await response.body?.cancel().catch(()=>{});if(!location||redirects===4)throw fail('PYTHON_ARTIFACT_REDIRECT_REJECTED');
      const next=new URL(location,url);if(next.protocol!=='https:'||next.username||next.password||next.hash||![new URL(artifact.url).hostname,...allowedRedirectHosts].includes(next.hostname))throw fail('PYTHON_ARTIFACT_REDIRECT_REJECTED');url=next;
    }
    if(!response?.ok||!response.body)throw fail('PYTHON_ARTIFACT_DOWNLOAD_FAILED');
    const declared=Number(response.headers.get('content-length'));if(declared&&declared!==artifact.sizeBytes)throw fail('PYTHON_ARTIFACT_SIZE_MISMATCH');
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>artifact.sizeBytes){callback(fail('PYTHON_ARTIFACT_SIZE_MISMATCH'));return;}hash.update(chunk);callback(null,chunk);}}),createWriteStream(temporary,{flags:'wx'}));
    if(bytes!==artifact.sizeBytes||hash.digest('hex')!==artifact.sha256)throw fail('PYTHON_ARTIFACT_HASH_MISMATCH');
    await rename(temporary,artifact.file);notify({stage:'artifact-verified',artifact:artifact.id,bytes,sha256:artifact.sha256});return {cached:false,sha256:artifact.sha256};
  }finally{await unlink(temporary).catch(()=>{});}
}
function setupEnvironment(env,root){
  const safe=pythonProcessEnvironment({platform:'win32',env});
  for(const name of ['USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','HOMEDRIVE','HOMEPATH']){const key=Object.keys(env).find(key=>key.toLowerCase()===name.toLowerCase());if(key&&typeof env[key]==='string'&&!/[\x00-\x1f\x7f]/.test(env[key]))safe[name]=env[key];}
  return {...safe,TEMP:path.join(root,'.local','p2p-python-temp'),TMP:path.join(root,'.local','p2p-python-temp')};
}
export async function verifyPythonAuthenticode(file,{env=process.env,execute=run}={}){
  const systemRoot=env.SystemRoot||env.SYSTEMROOT||'C:\\Windows',powershell=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),encodedFile=Buffer.from(file,'utf8').toString('base64');
  const script=`$ErrorActionPreference='Stop';$file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFile}'));$s=Get-AuthenticodeSignature -LiteralPath $file;[pscustomobject]@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress`;
  let result;try{result=await execute(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:60000,maxBuffer:65536,shell:false,windowsHide:true,env:pythonProcessEnvironment({platform:'win32',env})});}catch{throw fail('PYTHON_AUTHENTICODE_UNAVAILABLE');}
  let signature;try{signature=JSON.parse(result.stdout);}catch{throw fail('PYTHON_AUTHENTICODE_INVALID');}
  if(signature.status!=='Valid'||!/\bPython Software Foundation\b/.test(signature.subject||''))throw fail('PYTHON_AUTHENTICODE_INVALID');
  return {status:signature.status,subject:signature.subject,thumbprint:signature.thumbprint};
}
export async function applyPythonSetup(plan,{env=process.env,execute=run,fetch=globalThis.fetch,notify=()=>{}}={}){
  const report={schemaVersion:1,startedAt:new Date().toISOString(),scope:'private-python-and-frida',reboot:false,androidStarted:false,mainServerChanged:false,artifacts:[],status:'preparing'},reportFile=path.join(plan.root,'.local','p2p-python-setup.json');let release;
  const checkpoint=async stage=>{report.stage=stage;await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');notify({stage});};
  try{
    for(const target of [plan.runtime,plan.base,plan.venv,plan.downloads,path.join(plan.root,'.local','p2p-python-temp')])await assertPlainAncestors(plan.root,target);
    await mkdir(plan.downloads,{recursive:true});await mkdir(path.join(plan.root,'.local','p2p-python-temp'),{recursive:true});await mkdir(plan.runtime,{recursive:true});
    release=await acquireLauncherLock(path.join(plan.root,'.local','p2p-python-setup.lock'));await checkpoint('downloading');
    for(const artifact of plan.artifacts)report.artifacts.push({id:artifact.id,...await downloadPythonArtifact(artifact,{fetch,notify})});
    const installer=plan.artifacts[0],wheel=plan.artifacts[1];await checkpoint('signature');report.authenticode=await verifyPythonAuthenticode(installer.file,{env,execute});await checkpoint('installing-private-base');
    const childEnv=setupEnvironment(env,plan.root),options={timeout:300000,maxBuffer:2*1024*1024,shell:false,windowsHide:true,env:childEnv};
    const probe=async executable=>{try{const result=await execute(executable,['-I','-B','-X','utf8','-c','import json,sys;print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"prefix":sys.prefix,"base_prefix":sys.base_prefix}))'],{...options,timeout:15000});return JSON.parse(result.stdout);}catch{return null;}};
    let base=await probe(plan.basePython);
    if(!base){
      if(await exists(plan.basePython))throw fail('PYTHON_BASE_EXISTING_UNUSABLE');
      try{await execute(installer.file,pythonInstallerArguments(plan.base,path.join(plan.root,'.local','p2p-python-installer.log')),options);}catch(error){if(Number(error.code)===3010){report.rebootRequiredByInstaller=true;}else throw fail('PYTHON_INSTALLER_FAILED');}
      base=await probe(plan.basePython);
    }
    if(base?.version!==PYTHON||!equalPath(base.prefix,plan.base))throw fail('PYTHON_BASE_VALIDATION_FAILED');report.base={version:base.version,path:plan.basePython};await checkpoint('creating-private-venv');
    let venv=await probe(plan.python);
    if(!venv){if(await exists(plan.python))throw fail('PYTHON_VENV_EXISTING_UNUSABLE');await execute(plan.basePython,['-I','-B','-X','utf8','-m','venv',plan.venv],options);venv=await probe(plan.python);}
    if(venv?.version!==PYTHON||!equalPath(venv.prefix,plan.venv)||!equalPath(venv.base_prefix,plan.base))throw fail('PYTHON_VENV_VALIDATION_FAILED');await checkpoint('installing-verified-frida-wheel');
    await execute(plan.python,['-I','-B','-X','utf8','-m','pip','--isolated','--disable-pip-version-check','install','--no-index','--no-deps','--no-cache-dir',wheel.file],options);
    const result=await execute(plan.python,['-I','-B','-X','utf8','-c','import frida,json,sys;print(json.dumps({"python":".".join(map(str,sys.version_info[:3])),"frida":frida.__version__,"prefix":sys.prefix}))'],{...options,timeout:15000}),verified=JSON.parse(result.stdout);
    if(verified.python!==PYTHON||verified.frida!==FRIDA||!equalPath(verified.prefix,plan.venv))throw fail('PYTHON_FRIDA_VALIDATION_FAILED');
    report.status='ready-python-and-frida';report.verified={python:verified.python,frida:verified.frida,path:plan.python};report.completedAt=new Date().toISOString();await checkpoint('complete');return report;
  }catch(error){report.status='failed';report.error=/^[A-Z0-9_]+$/.test(error?.code||'')?error.code:'PYTHON_SETUP_FAILED';await writeFile(reportFile,JSON.stringify(report,null,2)+'\n').catch(()=>{});throw fail(report.error);}
  finally{await release?.();}
}

const main=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(main){
  const args=process.argv.slice(2),apply=args.includes('--apply');
  if(args.some(value=>!['--plan','--apply'].includes(value))||args.includes('--plan')&&apply){console.error('Usage: node tools/setup-p2p-python.mjs [--plan|--apply]');process.exitCode=1;}
  else try{const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),manifest=await loadP2PInstallPlan(root),plan=pythonSetupPlan(manifest,{root});if(!apply)console.log(JSON.stringify({...plan,apply:false},null,2));else{const result=await applyPythonSetup(plan,{notify:event=>console.log(JSON.stringify(event))});console.log(JSON.stringify({status:result.status,verified:result.verified,authenticode:result.authenticode.status,rebootRequiredByInstaller:result.rebootRequiredByInstaller===true,report:'.local/p2p-python-setup.json'}));}}
  catch(error){console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(error?.code||'')?error.code:'PYTHON_SETUP_FAILED'}));process.exitCode=1;}
}
