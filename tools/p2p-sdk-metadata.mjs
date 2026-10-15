import path from 'node:path';
import {access,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{code});
const normalizedVersion=value=>{const parts=String(value).split('.').map(Number);while(parts.length>1&&parts.at(-1)===0)parts.pop();return parts.join('.');};

/** Register official ZIPs with the SDK's local repository without another
 * package download. Keep the publisher's type details, revision and license. */
export function localSDKPackageXML(xml,{packagePath,version}){
  if(typeof xml!=='string'||xml.length>8*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(xml))throw fail('P2P_SDK_METADATA_INVALID');
  const expected=String(version).match(/revision\s+(\d+)/i)?.[1]||version;
  const selected=[...xml.matchAll(/<remotePackage\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g)].find(match=>{
    if(match[1]!==packagePath)return false;
    const revision=match[2].match(/<revision>([\s\S]*?)<\/revision>/)?.[1]||'';
    const parts=['major','minor','micro'].map(tag=>revision.match(new RegExp('<'+tag+'>(\\d+)</'+tag+'>'))?.[1]).filter(value=>value!==undefined);
    return normalizedVersion(parts.join('.'))===normalizedVersion(expected)&&!/<channelRef\s+ref="(?!channel-0)/.test(match[2]);
  });
  if(!selected)throw fail('P2P_SDK_METADATA_REVISION');
  const opening=xml.match(/<(?:[\w-]+:)?(?:sdk-repository|repository)\b[^>]*>/)?.[0];
  if(!opening)throw fail('P2P_SDK_METADATA_INVALID');
  const namespaceDeclarations=[...opening.matchAll(/xmlns(?::[\w-]+)?="[^"]+"/g)].map(match=>match[0]);
  const licenseID=selected[2].match(/<uses-license\s+ref="([^"]+)"/)?.[1];
  const license=[...xml.matchAll(/<license\s+id="([^"]+)"[^>]*>[\s\S]*?<\/license>/g)].find(match=>match[1]===licenseID)?.[0];
  if(licenseID!=='android-sdk-license'||!license)throw fail('P2P_SDK_METADATA_LICENSE');
  const local=selected[0].replace(/^<remotePackage/,'<localPackage').replace(/<\/remotePackage>$/,'</localPackage>')
    .replace(/<archives>[\s\S]*?<\/archives>/,'').replace(/<channelRef\s+[^>]*\/>/g,'');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<arkhen-local:repository xmlns:arkhen-local="http://schemas.android.com/repository/android/common/02" ${namespaceDeclarations.join(' ')}>${license}${local}</arkhen-local:repository>\n`;
}

export async function registerPreparedSDKPackage(row,{root,fetchImpl=fetch}={}){
  if(!row.packagePath)return {registered:false};
  if(!['https://dl.google.com/android/repository/repository2-3.xml','https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-1.xml'].includes(row.metadataSource))throw fail('P2P_SDK_METADATA_SOURCE');
  const file=path.join(row.destination,'package.xml'),base=await realpath(root),parent=await realpath(path.dirname(file)),relative=path.relative(base,parent);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw fail('P2P_PREPARATION_PATH');
  try{await access(file);return {registered:true,reused:true};}catch{}
  const response=await fetchImpl(row.metadataSource,{signal:AbortSignal.timeout(30000)});
  if(!response.ok||!response.body)throw fail('P2P_SDK_METADATA_FETCH');
  const parts=[];let length=0;for await(const chunk of response.body){length+=chunk.byteLength;if(length>8*1024*1024)throw fail('P2P_SDK_METADATA_INVALID');parts.push(Buffer.from(chunk));}
  const xml=localSDKPackageXML(Buffer.concat(parts).toString('utf8'),row),temporary=file+'.tmp-'+randomUUID();
  await writeFile(temporary,xml,{mode:0o600,flag:'wx'});await rename(temporary,file);
  // Only our generated metadata is read here; no SDK account/preferences.
  if(!(await readFile(file,'utf8')).includes('<localPackage'))throw fail('P2P_SDK_METADATA_WRITE');
  return {registered:true,reused:false};
}
