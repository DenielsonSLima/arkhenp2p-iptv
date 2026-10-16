import {readFile, lstat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const CORPUS=Object.freeze([
  {file:'index.md',domain:'shared'},
  {file:'shared.md',domain:'shared'},
  {file:'live.md',domain:'live'},
  {file:'movies.md',domain:'movies'},
  {file:'series.md',domain:'series'},
]);
const MAX_FILE_BYTES=24576,MAX_QUERY_CHARS=256,MAX_TERMS=16;
const fold=value=>value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
const STOP=new Set(['a','o','as','os','e','de','da','do','das','dos','em','no','na','nos','nas','para','por','com','um','uma']);
const domainAliases=new Map([['all','all'],['todos','all'],['live','live'],['tv','live'],['movies','movies'],['filmes','movies'],['series','series'],['shared','shared'],['comum','shared'],['compartilhado','shared']]);
const usage='Uso: node tools/retrieve-memory.mjs "termos" [--domain live|movies|series|shared|all] [--limit 1..8] [--max-chars 200..1600]';

function options(args){
  const query=[];let domain='all',limit=5,maxChars=1000;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--help'||arg==='-h')return {help:true};
    if(arg==='--domain'){
      domain=domainAliases.get(fold(args[++i]||''));
      if(!domain)throw new Error('Domínio inválido.');
    }else if(arg==='--limit'||arg==='--max-chars'){
      const raw=args[++i]||'',value=/^\d+$/.test(raw)?Number(raw):NaN;
      if(arg==='--limit'){
        if(!Number.isInteger(value)||value<1||value>8)throw new Error('Limite deve estar entre 1 e 8.');
        limit=value;
      }else{
        if(!Number.isInteger(value)||value<200||value>1600)throw new Error('Tamanho deve estar entre 200 e 1600 caracteres.');
        maxChars=value;
      }
    }else if(arg.startsWith('-'))throw new Error('Opção desconhecida.');
    else query.push(arg);
  }
  const text=query.join(' ').trim();
  if(!text||text.length>MAX_QUERY_CHARS)throw new Error('Informe uma consulta de 1 a 256 caracteres.');
  const terms=[...new Set((fold(text).match(/[\p{L}\p{N}]+/gu)||[]).filter(term=>!STOP.has(term)))];
  if(!terms.length||terms.length>MAX_TERMS)throw new Error('Use de 1 a 16 termos significativos.');
  return {domain,limit,maxChars,terms,phrase:fold(text)};
}

function sections(content){
  const rows=content.split(/\r?\n/),result=[];let current=null;
  for(let i=0;i<rows.length;i++){
    if(/^##\s+/.test(rows[i])){
      if(current)result.push(current);
      current={title:rows[i].replace(/^##\s+/,''),line:i+1,rows:[]};
    }else if(current)current.rows.push(rows[i]);
  }
  if(current)result.push(current);
  return result.map(section=>({...section,text:section.rows.join('\n').trim()}));
}

function score(section,{terms,phrase}){
  const title=fold(section.title),body=fold(section.text),matched=[];let value=0;
  for(const term of terms){
    const inTitle=title.includes(term),inBody=body.includes(term);
    if(!inTitle&&!inBody)continue;
    matched.push(term);value+=(inTitle?10:0)+(inBody?3:0);
  }
  if(!matched.length)return null;
  value+=matched.length/terms.length*10;
  if(title.includes(phrase))value+=15;
  return {score:Number(value.toFixed(2)),matched};
}

async function retrieve(config){
  const root=await realpath(ROOT),memory=path.join(root,'docs','memory');
  if((await lstat(memory)).isSymbolicLink())throw new Error('Corpus deve ser um diretório local do projeto.');
  const results=[];
  for(const item of CORPUS){
    if(config.domain!=='all'&&item.domain!==config.domain)continue;
    const filename=path.join(memory,item.file),info=await lstat(filename);
    if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_FILE_BYTES)throw new Error('Arquivo do corpus inválido ou maior que 24 KiB.');
    const actual=await realpath(filename);
    if(actual!==filename)throw new Error('Corpus não aceita redirecionamento por link.');
    const content=await readFile(actual,'utf8');
    if(Buffer.byteLength(content)>MAX_FILE_BYTES)throw new Error('Arquivo do corpus maior que 24 KiB.');
    for(const section of sections(content)){
      const ranking=score(section,config);if(!ranking)continue;
      results.push({path:'docs/memory/'+item.file,line:section.line,title:section.title,...ranking,text:section.text.length>config.maxChars?section.text.slice(0,config.maxChars-1)+'…':section.text});
    }
  }
  results.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)||a.line-b.line);
  return {domain:config.domain,totalMatches:results.length,results:results.slice(0,config.limit)};
}

try{
  const config=options(process.argv.slice(2));
  process.stdout.write(config.help?usage+'\n':JSON.stringify(await retrieve(config),null,2)+'\n');
}catch(error){
  const message=error?.code?'Não foi possível ler o corpus local permitido.':error.message;
  process.stderr.write(message+'\n'+usage+'\n');process.exitCode=1;
}
