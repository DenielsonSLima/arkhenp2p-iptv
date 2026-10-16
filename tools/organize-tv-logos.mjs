#!/usr/bin/env node
// Offline organization only. It never authenticates, downloads or transforms an image.
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,rename,rm,rmdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const SOURCE=path.join(ROOT,'web/assets/channels');
const OUTPUT=path.join(ROOT,'web/tv/logos');
const ID=/^\d{1,12}$/;
const CATEGORY_ID=/^[a-zA-Z0-9_-]{1,160}$/;
const LEGACY_FILE=/^\/assets\/channels\/([a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8,64}\.webp)$/;
const GROUPED_FILE=/^\/tv\/logos\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8,64}\.webp)$/;
const STAT_FIELDS=['sourceProvider','idNamespace','generatedAt','catalogChannels','sourceGroups','channelsWithoutSource',
  'downloadedSources','failedDownloads','optimizedSources','failedOptimizations','uniqueLogos','deduplicatedSources',
  'channelsCovered','channelsWithoutLocalLogo','sourceBytes','optimizedBytes','maxDimension','quality','method',
  'concurrency','downloadTimeoutMs','maxDownloadBytes'];
const UNKNOWN='sem-categoria-verificada';
const hash=value=>createHash('sha256').update(value).digest('hex');
const compare=(a,b)=>a<b?-1:a>b?1:0;
const namesEqual=(a,b)=>a.normalize('NFC')===b.normalize('NFC');

function name(value){
  if(typeof value!=='string'||!value.trim()||value.length>300||/[\u0000-\u001f\u007f]|https?:\/\//u.test(value))throw new Error('Nome de catálogo inválido.');
  return value;
}

function categorySlug(category){
  const stem=category.name.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70).replace(/-+$/,'')||'categoria';
  const suffix=category.id.length<=20?category.id.toLowerCase():hash(category.id).slice(0,12);
  return `${stem}-${suffix}`;
}

function normalizedCatalog(input){
  if(input?.idNamespace!=='native-channel-id'||!Array.isArray(input.categories)||input.categories.length>2000||
      !Array.isArray(input.items)||input.items.length>10000)throw new Error('Use somente um catálogo sanitizado do namespace native-channel-id.');
  if(input.source==='unavailable'&&!input.categories.length&&!input.items.length)return null;
  if(input.source!=='published-wplay-apk-live-catalog')throw new Error('A origem do snapshot de categorias não foi verificada.');
  const categories=input.categories.map(entry=>{
    if(!CATEGORY_ID.test(entry?.id||''))throw new Error('ID de categoria inválido.');
    return {id:entry.id,name:name(entry.name)};
  });
  if(new Set(categories.map(entry=>entry.id)).size!==categories.length)throw new Error('Categorias duplicadas.');
  const categoryIds=new Set(categories.map(entry=>entry.id));
  const items=input.items.map(entry=>{
    if(!ID.test(entry?.id||''))throw new Error('ID de canal inválido.');
    const ids=[...new Set([...(Array.isArray(entry.categoryIds)?entry.categoryIds:[]),entry.categoryId].filter(Boolean))];
    if(ids.some(id=>typeof id!=='string'||!categoryIds.has(id)))throw new Error('Categoria de canal não encontrada no catálogo.');
    return {id:entry.id,name:name(entry.name),categoryIds:ids.sort(compare),
      ...(typeof entry.categoryId==='string'&&categoryIds.has(entry.categoryId)?{categoryId:entry.categoryId}:{})};
  });
  if(new Set(items.map(entry=>entry.id)).size!==items.length)throw new Error('IDs de canal duplicados.');
  const observedAt=typeof input.observedAt==='string'&&Number.isFinite(Date.parse(input.observedAt))?new Date(input.observedAt).toISOString():null;
  return {schemaVersion:1,idNamespace:'native-channel-id',source:'published-wplay-apk-live-catalog',observedAt,
    categories:categories.sort((a,b)=>compare(a.id,b.id)),items:items.sort((a,b)=>compare(a.id,b.id))};
}

async function json(filename,value){
  const temporary=filename+'.tmp';
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n');
  await rename(temporary,filename);
}

function artwork(value){
  if(!Number.isInteger(value?.width)||!Number.isInteger(value?.height)||!Array.isArray(value.bounds)||value.bounds.length!==4||
    !value.bounds.every(Number.isInteger))return null;
  return {width:value.width,height:value.height,bounds:[...value.bounds]};
}

async function removePreviousLayout(previous,channels,categories,hasUnclassified){
  if(previous?.version!==2||!Array.isArray(previous.channels))return;
  const retained=new Set(channels.map(entry=>entry.file));
  for(const entry of previous.channels){
    if(GROUPED_FILE.test(entry?.file||'')&&!retained.has(entry.file))await rm(path.join(ROOT,'web',entry.file),{force:true});
  }
  const activeFolders=new Set(categories.map(entry=>entry.slug));
  if(hasUnclassified)activeFolders.add(UNKNOWN);
  const oldFolders=new Set(previous.channels.map(entry=>GROUPED_FILE.exec(entry?.file||'')?.[1]).filter(Boolean));
  for(const folder of oldFolders){
    if(activeFolders.has(folder))continue;
    await rm(path.join(OUTPUT,folder,'index.json'),{force:true});
    // Leave unrelated, manually maintained files alone.
    try{await rmdir(path.join(OUTPUT,folder));}catch(error){if(error.code!=='ENOTEMPTY'&&error.code!=='ENOENT')throw error;}
  }
}

async function organize(catalogPath){
  const rawManifest=await readFile(path.join(SOURCE,'manifest.json'),'utf8');
  const original=JSON.parse(rawManifest);
  if(original?.version!==1||original.stats?.idNamespace!=='native-channel-id'||!Array.isArray(original.channels)||original.channels.length>10000)throw new Error('Manifesto de logos nativos inválido.');
  let catalog=null;
  const snapshotPath=catalogPath?path.resolve(catalogPath):path.join(OUTPUT,'catalogo-categorias.json');
  try{catalog=normalizedCatalog(JSON.parse(await readFile(snapshotPath,'utf8')));}
  catch(error){if(catalogPath||error.code!=='ENOENT')throw error;}
  let previous=null;
  try{previous=JSON.parse(await readFile(path.join(OUTPUT,'manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous?.stats?.verifiedCategories>0&&!catalog)throw new Error('Um snapshot vazio não substitui categorias verificadas.');
  const categories=new Map((catalog?.categories||[]).map(entry=>[entry.id,{...entry,slug:categorySlug(entry)}]));
  const items=new Map((catalog?.items||[]).map(entry=>[entry.id,entry]));
  const channels=[],legacyAliases={},categorizedChannels=new Set(),unverifiedChannels=new Set(),usedFiles=new Set();
  const categoryFiles=new Map([...categories.keys()].map(id=>[id,new Set()]));
  await mkdir(OUTPUT,{recursive:true});
  for(const entry of original.channels){
    const match=LEGACY_FILE.exec(entry?.file||'');
    if(!match||!Array.isArray(entry.ids)||!entry.ids.length||!entry.ids.every(id=>typeof id==='string'&&ID.test(id))||
      !Array.isArray(entry.names)||!entry.names.length)throw new Error('Registro de logo inválido.');
    entry.names.forEach(name);
    if(usedFiles.has(match[1]))throw new Error('Arquivo de logo duplicado.');
    usedFiles.add(match[1]);
    const memberships=new Map();
    for(const id of entry.ids){
      const item=items.get(id);
      // ID alone is insufficient when crossing cached catalog generations.
      if(!item||!entry.names.some(value=>namesEqual(value,item.name))||!item.categoryIds.length){unverifiedChannels.add(id);continue;}
      categorizedChannels.add(id);
      for(const categoryId of item.categoryIds)memberships.set(categoryId,(memberships.get(categoryId)||0)+1);
    }
    const categoryIds=[...memberships.keys()].sort(compare);
    const primaryCategoryId=categoryIds.sort((a,b)=>memberships.get(b)-memberships.get(a)||compare(a,b))[0]||null;
    categoryIds.sort(compare);
    const folder=primaryCategoryId?categories.get(primaryCategoryId).slug:UNKNOWN;
    await mkdir(path.join(OUTPUT,folder),{recursive:true});
    const bytes=await readFile(path.join(SOURCE,match[1])),sha256=hash(bytes);
    const file=`/tv/logos/${folder}/${match[1]}`;
    await copyFile(path.join(SOURCE,match[1]),path.join(OUTPUT,folder,match[1]));
    legacyAliases[entry.file]=file;
    const geometry=artwork(entry.artwork);
    channels.push({file,ids:[...entry.ids],names:[...entry.names],...(geometry?{artwork:geometry}:{}),
      legacyFile:entry.file,sha256,categoryIds,primaryCategoryId});
    for(const id of categoryIds)categoryFiles.get(id).add(file);
  }
  const categoryIndex=[...categories.values()].map(entry=>({...entry,logoCount:categoryFiles.get(entry.id).size}));
  for(const category of categoryIndex){
    await mkdir(path.join(OUTPUT,category.slug),{recursive:true});
    await json(path.join(OUTPUT,category.slug,'index.json'),{schemaVersion:1,categoryId:category.id,name:category.name,
      // A shared logo lives only in its primary category; all memberships refer to it.
      files:[...categoryFiles.get(category.id)].sort(compare)});
  }
  const unclassified=channels.filter(entry=>!entry.primaryCategoryId).map(entry=>entry.file);
  if(unclassified.length){
    await mkdir(path.join(OUTPUT,UNKNOWN),{recursive:true});
    await json(path.join(OUTPUT,UNKNOWN,'index.json'),{schemaVersion:1,categoryId:null,name:'Sem categoria verificada',files:unclassified});
  }
  const manifest={version:2,channels,categories:categoryIndex,legacyAliases,
    provenance:{logoSource:'wplay-p2p-apk-11.9.0d',idNamespace:'native-channel-id',sourceManifestSha256:hash(rawManifest),
      logoSnapshotAt:original.stats.generatedAt,categorySource:catalog?.source||'unavailable',categorySnapshotAt:catalog?.observedAt||null,
      categoryEvidence:catalog?'published-catalog-id-and-exact-name':'no-verified-category-snapshot'},
    stats:{...Object.fromEntries(STAT_FIELDS.filter(key=>typeof original.stats[key]==='number'||typeof original.stats[key]==='string').map(key=>[key,original.stats[key]])),
      organizedLogos:channels.length,verifiedCategories:categories.size,
      categorizedChannels:categorizedChannels.size,unverifiedChannels:unverifiedChannels.size,
      primaryCategoryLogos:channels.length-unclassified.length,unclassifiedLogos:unclassified.length,
      duplicateCategoryImageBytes:0,legacyFilesRetained:true}};
  await json(path.join(OUTPUT,'manifest.json'),manifest);
  await json(path.join(OUTPUT,'catalogo-categorias.json'),catalog||{schemaVersion:1,idNamespace:'native-channel-id',source:'unavailable',observedAt:null,categories:[],items:[]});
  const failures=JSON.parse(await readFile(path.join(SOURCE,'failures.json'),'utf8'));
  await json(path.join(OUTPUT,'failures.json'),{version:1,failures:(failures.failures||[]).map(entry=>({
    ids:entry.ids.filter(id=>ID.test(id)),names:entry.names.map(name),
    reason:typeof entry.reason==='string'&&/^[A-Za-z_]{1,64}$/.test(entry.reason)?entry.reason:'UNKNOWN',
    ...(Number.isInteger(entry.status)?{status:entry.status}:{})}))});
  await writeFile(path.join(OUTPUT,'README.md'),`# Logos de TV\n\nImagens originais WebP do catálogo WPLAYP2P 11.9.0d, sem download, edição ou reprodução nesta reorganização.\n\nO manifesto associa IDs nativos e nomes exatos. A categoria vem somente de um snapshot sanitizado publicado; não é inferida do nome do canal, da marca ou das categorias de outro servidor. A lista de categorias é um dado recebido em execução pelo APK, não uma lista fixa embutida nele.\n\n- Logos distintos: ${channels.length}\n- IDs com logo: ${new Set(channels.flatMap(entry=>entry.ids)).size}\n- IDs com categoria verificada: ${categorizedChannels.size}\n- Categorias verificadas: ${categories.size}\n- Logos sem categoria verificada: ${unclassified.length}\n\nCada WebP tem um arquivo canônico na categoria com maior número de canais associados (desempate por ID). Os arquivos index.json das demais categorias apontam para esse mesmo arquivo. Hash SHA-256 integral e geometria visual estão no manifesto.\n\nOs arquivos antigos em /assets/channels/ permanecem durante a migração de URLs de favoritos e cache. legacyAliases permite ao servidor resolver esses endereços sem mudar a identidade dos canais. Essa cópia temporária é de compatibilidade, não de categorias.\n\nRegenerar, sem rede ou credenciais:\n\n\x60\x60\x60sh\nnode tools/organize-tv-logos.mjs --catalog web/tv/logos/catalogo-categorias.json\n\x60\x60\x60\n\nO catálogo de entrada contém somente schemaVersion, idNamespace, observedAt, categories (id/name) e items (id/name/categoryIds/categoryId opcional). Sem snapshot verificado, omitir --catalog conserva todos em ${UNKNOWN}; isso explicita a falta de evidência. O manifesto anterior não é descartado por uma categoria ausente.\n`);
  await removePreviousLayout(previous,channels,categoryIndex,unclassified.length>0);
  console.log(JSON.stringify({manifest:'web/tv/logos/manifest.json',logos:channels.length,categories:categories.size,
    categorizedChannels:categorizedChannels.size,unverifiedChannels:unverifiedChannels.size,legacyFilesRetained:true}));
}

const args=process.argv.slice(2);
if(args.includes('--help'))console.log('Uso: node tools/organize-tv-logos.mjs [--catalog snapshot-sanitizado.json]\nOrganiza somente os WebP locais; não usa rede, credenciais, engine ou vídeo.');
else if(args.length!==0&&(args.length!==2||args[0]!=='--catalog')){console.error('Argumentos inválidos. Use --help.');process.exitCode=1;}
else organize(args[1]).catch(()=>{console.error('Não foi possível organizar os logos. Confira manifesto, arquivos locais e snapshot sanitizado.');process.exitCode=1;});
