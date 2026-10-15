#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile,writeFile,mkdir,access,lstat,rename,unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadP2PInstallPlan} from './p2p-install-plan.mjs';
import {downloadPythonArtifact} from './setup-p2p-python.mjs';
import {pythonProcessEnvironment} from './p2p-runtime-paths.mjs';
const execute=promisify(execFile),VERSION='17.8.0',BASENAME=`frida-server-${VERSION}-android-x86_64`,HASH='7239c00658dba7b0bfaf9ae25d187494528bfe6b56cfd15c8155387fbb486cb9';
const fail=code=>Object.assign(new Error(code),{code});
const present=async file=>{try{await access(file);return true;}catch{return false;}};
const hashFile=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
export function fridaServerSetupPlan(manifest,{root,platform=process.platform,arch=process.arch}={}){
  const item=manifest?.artifacts?.find(artifact=>artifact.id==='frida-android-server');
  if(platform!=='win32'||arch!=='x64'||item?.version!==VERSION||item.url!==`https://github.com/frida/frida/releases/download/${VERSION}/${BASENAME}.xz`||item.sizeBytes!==31681992||item.checksums?.sha256!==HASH)throw fail('FRIDA_SERVER_SOURCE_NOT_PINNED');
  const runtime=path.join(root,'native-bridge','debug-runtime'),directory=path.join(runtime,'frida');
  return {version:VERSION,architecture:'android-x86_64',compressed:{id:item.id,url:item.url,sizeBytes:item.sizeBytes,sha256:HASH,file:path.join(root,'.local','p2p-downloads',BASENAME+'.xz')},python:path.join(runtime,'python','Scripts','python.exe'),directory,binary:path.join(directory,BASENAME),report:path.join(root,'.local','p2p-frida-server-setup.json'),root,executesAndroidBinary:false,pushesAndroid:false};
}
export const EXTRACT_FRIDA_XZ=`import sys,lzma,hashlib,json,pathlib,struct
source,target=sys.argv[1:3]
total=0;digest=hashlib.sha256()
with lzma.open(source,'rb') as src,open(target,'xb') as dst:
 while True:
  block=src.read(1024*1024)
  if not block:break
  total+=len(block)
  if total>256*1024*1024:raise ValueError('FRIDA_SERVER_TOO_LARGE')
  digest.update(block);dst.write(block)
with open(target,'rb') as stream:header=stream.read(64)
if len(header)!=64 or header[:4]!=bytes([127,69,76,70]) or header[4]!=2 or header[5]!=1 or struct.unpack_from('<H',header,18)[0]!=62:raise ValueError('FRIDA_SERVER_ELF_INVALID')
print(json.dumps({'elfClass':64,'architecture':'x86_64','bytes':total,'sha256':digest.hexdigest()}))`;
export async function prepareFridaServer(plan,{fetch=globalThis.fetch,run=execute,env=process.env,notify=()=>{}}={}){
  for(const target of [path.join(plan.root,'.local'),path.dirname(plan.compressed.file),path.join(plan.root,'native-bridge'),path.join(plan.root,'native-bridge','debug-runtime'),plan.directory]){try{if((await lstat(target)).isSymbolicLink())throw fail('FRIDA_SERVER_PATH_SYMLINK');}catch(error){if(error.code!=='ENOENT')throw error;}}
  await mkdir(plan.directory,{recursive:true});await mkdir(path.dirname(plan.compressed.file),{recursive:true});
  await downloadPythonArtifact(plan.compressed,{fetch,notify,allowedRedirectHosts:['release-assets.githubusercontent.com','objects.githubusercontent.com']});
  const temporary=plan.binary+'.part-'+process.pid;
  try{
    const result=await run(plan.python,['-I','-B','-X','utf8','-c',EXTRACT_FRIDA_XZ,plan.compressed.file,temporary],{timeout:120000,maxBuffer:8192,shell:false,windowsHide:true,env:pythonProcessEnvironment({platform:'win32',env})});
    const elf=JSON.parse(result.stdout);if(elf.elfClass!==64||elf.architecture!=='x86_64'||!Number.isSafeInteger(elf.bytes)||elf.bytes<64||!/^[a-f0-9]{64}$/.test(elf.sha256))throw fail('FRIDA_SERVER_ELF_INVALID');
    if(await present(plan.binary)){if((await lstat(plan.binary)).isSymbolicLink()||await hashFile(plan.binary)!==elf.sha256)throw fail('FRIDA_SERVER_EXISTING_BINARY_DIFFERS');}else await rename(temporary,plan.binary);
    const report={schemaVersion:1,preparedAt:new Date().toISOString(),version:VERSION,source:plan.compressed.url,compressedSHA256:HASH,compressedBytes:plan.compressed.sizeBytes,...elf,binary:plan.binary,executed:false,pushedAndroid:false,reboot:false};
    await writeFile(plan.report,JSON.stringify(report,null,2)+'\n');return report;
  }finally{await unlink(temporary).catch(()=>{});}
}
const main=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(main){const flags=process.argv.slice(2);if(flags.some(flag=>!['--plan','--apply'].includes(flag))||flags.includes('--plan')&&flags.includes('--apply')){console.error('Usage: node tools/setup-p2p-frida-server.mjs [--plan|--apply]');process.exitCode=1;}
else try{const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),plan=fridaServerSetupPlan(await loadP2PInstallPlan(root),{root});console.log(JSON.stringify(flags.includes('--apply')?await prepareFridaServer(plan,{notify:event=>console.log(JSON.stringify(event))}):plan,null,2));}catch(error){console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(error?.code||'')?error.code:'FRIDA_SERVER_PREPARATION_FAILED'}));process.exitCode=1;}}
