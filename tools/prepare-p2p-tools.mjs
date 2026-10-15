#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {access,mkdir,mkdtemp,open,readFile,readdir,realpath,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pythonProcessEnvironment} from './p2p-runtime-paths.mjs';
import {loadP2PInstallPlan} from './p2p-install-plan.mjs';

const exec=promisify(execFile),ids=['jdk','android-commandline-tools'];
const error=code=>Object.assign(new Error(code),{code});
const present=async file=>{try{await access(file);return true;}catch{return false;}};
const digest=async(file,algorithm='sha256')=>{const hash=createHash(algorithm);for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const within=(parent,target)=>{const relative=path.relative(path.resolve(parent),path.resolve(target));return Boolean(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};

export function validatedToolArtifacts(manifest,root){
  if(manifest?.host?.platform!=='win32'||manifest?.host?.architecture!=='x64')throw error('P2P_PREPARATION_HOST');
  const runtime=path.join(root,'native-bridge','debug-runtime');
  return ids.map(id=>{
    const row=manifest.artifacts?.find(item=>item.id===id);let url;try{url=new URL(row?.url);}catch{throw error('P2P_PREPARATION_MANIFEST');}
    const allowed=id==='jdk'?url.hostname==='github.com'&&url.pathname.startsWith('/adoptium/temurin21-binaries/releases/download/'):url.hostname==='dl.google.com'&&/^\/android\/repository\/commandlinetools-win-\d+_latest\.zip$/.test(url.pathname);
    const destination=path.join(runtime,...(id==='jdk'?['jdk']:['android-sdk','cmdline-tools','latest']));
    const filename=url.pathname.split('/').at(-1);
    if(!allowed||url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||!/^[-A-Za-z0-9_.]+\.zip$/.test(filename)||row.archiveFormat!=='zip'||!Number.isSafeInteger(row.sizeBytes)||row.sizeBytes<1||row.sizeBytes>512*1024*1024||!/^[a-f0-9]{64}$/.test(row.checksums?.sha256)||path.resolve(row.destination)!==path.resolve(destination))throw error('P2P_PREPARATION_MANIFEST');
    return {...row,filename,destination};
  });
}

/** Reject symlink/junction escapes before any generated-path directory move. */
export async function assertPreparationPath(root,target){
  if(!within(root,target))throw error('P2P_PREPARATION_PATH');
  const base=await realpath(root);let ancestor=path.resolve(target);
  while(!await present(ancestor)){const next=path.dirname(ancestor);if(next===ancestor)throw error('P2P_PREPARATION_PATH');ancestor=next;}
  const actual=await realpath(ancestor);if(actual!==base&&!within(base,actual))throw error('P2P_PREPARATION_PATH');
  return path.resolve(target);
}

export async function downloadPinnedArchive(row,cache,{fetchImpl=fetch,notify=()=>{}}={}){
  const algorithm=row.checksums.sha256?'sha256':'sha1',expected=row.checksums[algorithm];
  if(!/^[-A-Za-z0-9_.]+$/.test(row.filename)||!Number.isSafeInteger(row.sizeBytes)||row.sizeBytes<1||row.sizeBytes>2*1024**3||!(algorithm==='sha256'?/^[a-f0-9]{64}$/:/^[a-f0-9]{40}$/).test(expected))throw error('P2P_PREPARATION_MANIFEST');
  const file=path.join(cache,row.filename);
  if(await present(file)){if((await stat(file)).size!==row.sizeBytes||await digest(file,algorithm)!==expected)throw error('P2P_ARCHIVE_CACHE_MISMATCH');notify({id:row.id,stage:'checksum-verified',algorithm,cached:true});return file;}
  const partial=file+'.part-'+randomUUID();const output=await open(partial,'wx',0o600),hash=createHash(algorithm);let received=0;
  try{
    const response=await fetchImpl(row.url,{signal:AbortSignal.timeout(1800000),headers:{'User-Agent':'ARKHEN-Runtime-Preparation/1'}});
    if(!response.ok||!response.body)throw error('P2P_ARCHIVE_DOWNLOAD_FAILED');
    // fetch decompresses an HTTP content-encoding. Content-Length then refers
    // to compressed transfer bytes; size/hash below always validate the ZIP.
    const declared=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
    if(declared&&(!encoding||encoding==='identity')&&Number(declared)!==row.sizeBytes){await response.body.cancel().catch(()=>{});throw error('P2P_ARCHIVE_SIZE_MISMATCH');}
    notify({id:row.id,stage:'download-started',bytes:row.sizeBytes});
    for await(const chunk of response.body){received+=chunk.byteLength;if(received>row.sizeBytes)throw error('P2P_ARCHIVE_SIZE_MISMATCH');hash.update(chunk);await output.writeFile(chunk);}
    if(received!==row.sizeBytes)throw error('P2P_ARCHIVE_SIZE_MISMATCH');
    if(hash.digest('hex')!==expected)throw error('P2P_ARCHIVE_CHECKSUM_MISMATCH');
    await output.close();await rename(partial,file);notify({id:row.id,stage:'checksum-verified',algorithm,cached:false});return file;
  }catch(cause){await output.close().catch(()=>{});await unlink(partial).catch(()=>{});throw cause?.code?.startsWith('P2P_')?cause:error('P2P_ARCHIVE_DOWNLOAD_FAILED');}
}

const unzipScript=`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source=$env:ARKHEN_PREPARE_ARCHIVE
$destination=[System.IO.Path]::GetFullPath($env:ARKHEN_PREPARE_DESTINATION)
$prefix=$destination.TrimEnd('\\')+'\\'
$archive=[System.IO.Compression.ZipFile]::OpenRead($source)
try {
  if($archive.Entries.Count -gt 50000){throw 'ARCHIVE_LIMIT'}
  [long]$total=0
  foreach($entry in $archive.Entries){
    $relative=$entry.FullName.Replace('\\','/')
    if($relative -match '(^|/)\\.\\.(/|$)|^[A-Za-z]:|^/|:' -or ($entry.ExternalAttributes -shr 16 -band 61440) -eq 40960){throw 'ARCHIVE_PATH'}
    $target=[System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destination,$entry.FullName))
    if(-not $target.StartsWith($prefix,[System.StringComparison]::OrdinalIgnoreCase)){throw 'ARCHIVE_PATH'}
    $total+=$entry.Length
    if($total -gt [long]$env:ARKHEN_PREPARE_MAX_BYTES){throw 'ARCHIVE_LIMIT'}
  }
} finally {$archive.Dispose()}
[System.IO.Compression.ZipFile]::ExtractToDirectory($source,$destination)`;

export async function extractPinnedZip(file,destination,{run=exec,env=process.env,maxUncompressedBytes=2*1024**3}={}){
  if(!Number.isSafeInteger(maxUncompressedBytes)||maxUncompressedBytes<1||maxUncompressedBytes>8*1024**3)throw error('P2P_PREPARATION_MANIFEST');
  const executable=path.win32.join(env.SystemRoot||env.SYSTEMROOT||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  try{await run(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(unzipScript,'utf16le').toString('base64')],
    {timeout:180000,maxBuffer:65536,windowsHide:true,shell:false,env:{...pythonProcessEnvironment({platform:'win32',env}),ARKHEN_PREPARE_ARCHIVE:file,ARKHEN_PREPARE_DESTINATION:destination,ARKHEN_PREPARE_MAX_BYTES:String(maxUncompressedBytes)}});}
  catch{throw error('P2P_ARCHIVE_EXTRACT_FAILED');}
}

export async function prepareP2PTools({root,manifest,apply=false,platform=process.platform,arch=process.arch,fetchImpl=fetch,unpack=extractPinnedZip,run=exec,env=process.env,notify=()=>{}}){
  const rows=validatedToolArtifacts(manifest,root),runtime=path.join(root,'native-bridge','debug-runtime'),cache=path.join(root,'.local','p2p-downloads');
  if(!apply)return {dryRun:true,artifacts:rows.map(({id,version,sizeBytes,destination})=>({id,version,sizeBytes,destination})),licensesAccepted:false};
  if(platform!=='win32'||arch!=='x64')throw error('P2P_PREPARATION_HOST');
  await assertPreparationPath(root,runtime);await assertPreparationPath(root,cache);await mkdir(runtime,{recursive:true});await mkdir(cache,{recursive:true});
  const outcomes=await Promise.allSettled(rows.map(async row=>{
    await assertPreparationPath(root,row.destination);
    if(await present(row.destination)){
      let receipt;try{receipt=JSON.parse(await readFile(path.join(row.destination,'.arkhen-prepared.json'),'utf8'));}catch{}
      const expectedBinary=path.join(row.destination,'bin',row.id==='jdk'?'java.exe':'sdkmanager.bat');
      if(receipt?.sha256!==row.checksums.sha256||!await present(expectedBinary))throw error('P2P_PREPARATION_DESTINATION_EXISTS');
      return {id:row.id,version:row.version,destination:row.destination,reused:true};
    }
    const archive=await downloadPinnedArchive(row,cache,{fetchImpl,notify}),stage=await mkdtemp(path.join(runtime,'.prepare-'+row.id+'-'));
    await assertPreparationPath(root,stage);const extraction=path.join(stage,'extracted');
    await unpack(archive,extraction,{run,env});
    const children=await readdir(extraction,{withFileTypes:true}),directories=children.filter(entry=>entry.isDirectory());
    if(directories.length!==1||children.length!==1)throw error('P2P_ARCHIVE_LAYOUT');
    const source=path.join(extraction,directories[0].name),required=row.id==='jdk'?['bin/java.exe']:['bin/sdkmanager.bat','bin/avdmanager.bat'];
    for(const relative of required)if(!await present(path.join(source,relative)))throw error('P2P_ARCHIVE_LAYOUT');
    await assertPreparationPath(root,source);await assertPreparationPath(root,row.destination);await mkdir(path.dirname(row.destination),{recursive:true});
    await rename(source,row.destination);
    await writeFile(path.join(row.destination,'.arkhen-prepared.json'),JSON.stringify({id:row.id,version:row.version,sha256:row.checksums.sha256,preparedAt:new Date().toISOString(),source:row.url},null,2),{mode:0o600});
    notify({id:row.id,stage:'prepared'});return {id:row.id,version:row.version,destination:row.destination,reused:false};
  }));
  const failed=outcomes.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  const results=outcomes.map(result=>result.value);
  return {prepared:results,licensesAccepted:false,osChanges:false,androidStarted:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const flags=process.argv.slice(2),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  if(flags.some(flag=>flag!=='--apply')){console.error('Usage: node tools/prepare-p2p-tools.mjs [--apply]');process.exitCode=1;}
  else try{const manifest=await loadP2PInstallPlan(root);const result=await prepareP2PTools({root,manifest,apply:flags.includes('--apply'),notify:event=>console.log(JSON.stringify(event))});console.log(JSON.stringify(result));}
  catch(cause){console.error(JSON.stringify({code:cause?.code?.startsWith('P2P_')?cause.code:'P2P_PREPARATION_FAILED'}));process.exitCode=1;}
}
