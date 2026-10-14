// Read-only runtime observation of the user's isolated, unmodified WPLAY APK.
// Raw Android logs may contain account data: never emit or persist those logs.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),adb='/opt/homebrew/bin/adb',target=['-P','5038','-s','emulator-5580'];
const emit=value=>console.log(JSON.stringify(value));
try{
 const {stdout:pidText}=await exec(adb,[...target,'shell','pidof','io.wareztv.android.one'],{timeout:5000});
 const pid=pidText.trim();if(!/^\d+$/.test(pid))throw new Error('ORIGINAL_APP_NOT_RUNNING');
 const {stdout:logs}=await exec(adb,[...target,'logcat','--pid='+pid,'-d','-t','3000'],{timeout:8000,maxBuffer:4*1024*1024});
 const found=[...logs.matchAll(/http:\/\/127\.0\.0\.1:8902\/(?:\d+\/(?:main|index)\.m3u8|mpegts_live)/g)].map(match=>match[0]);
 const candidates=[...new Set(found)].slice(-4).reverse();
 emit({phase:'original-app',running:true,observedLocalPlaylists:candidates.filter(url=>url.endsWith('.m3u8')).length});
 for(const url of candidates){
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(7000)});
  const reader=response.body?.getReader();let bytes=0,parts=[];
  if(reader)try{while(bytes<32768){const {value,done}=await reader.read();if(done)break;parts.push(value);bytes+=value.length;}}finally{await reader.cancel().catch(()=>{});}
  const sample=Buffer.concat(parts),hls=sample.toString().startsWith('#EXTM3U');
  const ts=sample.length>=376&&Array.from({length:Math.min(4,Math.floor(sample.length/188))},(_,i)=>sample[i*188]===0x47).every(Boolean);
  emit({phase:'local-output',path:new URL(url).pathname,status:response.status,bytes,hls,mpegts:ts});
 }
 if(!candidates.length)emit({phase:'local-output',state:'NO_PREPARED_URL_OBSERVED'});
}catch(error){emit({phase:'observation-failed',code:/^[A-Z_]+$/.test(error.message)?error.message:error.code||error.name});process.exitCode=1;}
