import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {absoluteRuntimePath} from './p2p-runtime-paths.mjs';
const fail=code=>Object.assign(new Error(code),{code});
export function materializeP2PInstallPlan(manifest,{root,platform=process.platform,arch=process.arch}={}){
  const paths=platform==='win32'?path.win32:path.posix,workspace=absoluteRuntimePath(root,{platform}),host=manifest?.hosts?.find(host=>host.platform===platform&&host.architecture===arch);
  if(manifest?.schemaVersion!==1||!host||!Array.isArray(host.artifacts))throw fail('P2P_INSTALL_HOST_NOT_PINNED');
  const artifacts=host.artifacts.map(artifact=>{
    const relative=artifact.destinationRelative;
    if(typeof relative!=='string'||!/^native-bridge\/debug-runtime\/[A-Za-z0-9._/-]+$/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..')||Object.hasOwn(artifact,'destination'))throw fail('P2P_INSTALL_MANIFEST_PATH_INVALID');
    const {destinationRelative,...fields}=artifact;return {...fields,destination:paths.join(workspace,...destinationRelative.split('/'))};
  });
  return {schemaVersion:1,source:'versioned-public-artifact-manifest',researchedAt:manifest.researchedAt,host:{platform,architecture:arch},workspace,runtimeDirectory:paths.join(workspace,'native-bridge','debug-runtime'),downloadDirectory:paths.join(workspace,'.local','p2p-downloads'),artifacts};
}
/** Old local research plans remain optional. A clone with no private files
 * builds all destinations from the current workspace and versioned sources. */
export async function loadP2PInstallPlan(root,{platform=process.platform,arch=process.arch,read=readFile}={}){
  const paths=platform==='win32'?path.win32:path.posix;let local;
  try{local=JSON.parse(await read(paths.join(root,'.local','p2p-install-plan.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw fail('P2P_LOCAL_INSTALL_PLAN_INVALID');}
  if(local&&typeof local.workspace==='string'&&paths.normalize(local.workspace).toLowerCase()===paths.normalize(root).toLowerCase())return local;
  let manifest;try{manifest=JSON.parse(await read(paths.join(root,'tools','p2p-install-artifacts.json'),'utf8'));}catch{throw fail('P2P_PUBLIC_INSTALL_MANIFEST_INVALID');}
  return materializeP2PInstallPlan(manifest,{root,platform,arch});
}
