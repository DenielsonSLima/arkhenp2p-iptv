import test from 'node:test';
import assert from 'node:assert/strict';
import {centerSubtitleCue, SubtitleLayout} from '../web/subtitle-layout.js';

const cue=(text='Uma legenda de exemplo')=>({text,startTime:10,endTime:14,region:{id:'right'},vertical:'rl',snapToLines:false,line:92,lineAlign:'start',position:95,positionAlign:'line-right',size:100,align:'end'});
class Track extends EventTarget {
  constructor(kind='subtitles',cues=[cue()]) {super();this.kind=kind;this.mode='showing';this.cues=cues;this.activeCues=cues;}
}
class TrackList extends EventTarget {
  constructor(tracks=[]) {super();this.items=tracks;}
  [Symbol.iterator]() {return this.items[Symbol.iterator]();}
}
class Video extends EventTarget {
  constructor(tracks=[]) {super();this.textTracks=new TrackList(tracks);}
}

test('provider cue boxes become centered and smaller without changing text or timing',()=>{
  const value=cue(),original={text:value.text,startTime:value.startTime,endTime:value.endTime};
  assert.equal(centerSubtitleCue(value),true);
  assert.equal(value.position,50);assert.equal(value.positionAlign,'center');assert.equal(value.align,'center');assert.equal(value.size,86);
  assert.equal(value.region,null);assert.equal(value.vertical,'');assert.equal(value.snapToLines,true);assert.equal(value.line,-2);
  assert.deepEqual({text:value.text,startTime:value.startTime,endTime:value.endTime},original);
  assert.equal(centerSubtitleCue(value),false,'Unchanged cues do not force another native layout.');
  centerSubtitleCue(value,{controlsVisible:true});assert.equal(value.line,-5);
});

test('read-only native cue fields and non-text data cannot break playback',()=>{
  const value=cue();Object.defineProperty(value,'position',{get:()=>95,set:()=>{throw new TypeError('read-only');}});
  assert.doesNotThrow(()=>centerSubtitleCue(value));assert.equal(value.align,'center');assert.equal(value.position,95);
  assert.doesNotThrow(()=>centerSubtitleCue(Object.freeze(cue())));
  const inaccessible={};Object.defineProperty(inaccessible,'text',{get:()=>{throw new TypeError('native cue unavailable');}});assert.equal(centerSubtitleCue(inaccessible),false);
  const data={value:{payload:'metadata'}};assert.equal(centerSubtitleCue(data),false);assert.deepEqual(data,{value:{payload:'metadata'}});
});

test('existing and newly active subtitles are corrected without changing selected tracks or metadata cues',()=>{
  const subtitles=new Track(),metadata=new Track('metadata'),video=new Video([subtitles,metadata]);
  const layout=new SubtitleLayout({video,getControlsRoot:()=>null});layout.attach();
  assert.equal(subtitles.cues[0].position,50);assert.equal(subtitles.mode,'showing');assert.equal(metadata.cues[0].position,95);
  const incoming=cue('Próxima frase');subtitles.cues.push(incoming);subtitles.activeCues=[incoming];subtitles.dispatchEvent(new Event('cuechange'));
  assert.equal(incoming.position,50);assert.equal(incoming.text,'Próxima frase');layout.stop();
});

test('new native tracks and parsed HLS cues receive the same layout; removed tracks lose listeners',()=>{
  const video=new Video(),layout=new SubtitleLayout({video,getControlsRoot:()=>null});layout.attach();
  const added=new Track('captions');video.textTracks.items.push(added);video.textTracks.dispatchEvent(new Event('addtrack'));
  assert.equal(added.cues[0].position,50);
  const parsed=cue('Cue HLS recém-chegado');layout.refresh([parsed]);assert.equal(parsed.positionAlign,'center');
  video.textTracks.items=[];video.textTracks.dispatchEvent(new Event('removetrack'));
  added.cues[0].position=90;added.dispatchEvent(new Event('cuechange'));assert.equal(added.cues[0].position,90);layout.stop();
});

test('cues move above visible controls and return toward the bottom after controls hide',t=>{
  const previous=globalThis.MutationObserver,observers=[];
  globalThis.MutationObserver=class {constructor(callback){this.callback=callback;observers.push(this);}observe(root,options){this.root=root;this.options=options;}disconnect(){this.disconnected=true;}};
  t.after(()=>{if(previous===undefined)delete globalThis.MutationObserver;else globalThis.MutationObserver=previous;});
  let hidden=false;const root={hidden:false,classList:{contains:name=>name==='ip-hidden'&&hidden}},track=new Track(),video=new Video([track]);
  const layout=new SubtitleLayout({video,getControlsRoot:()=>root});layout.attach();assert.equal(track.cues[0].line,-5);
  hidden=true;observers[0].callback();assert.equal(track.cues[0].line,-2);
  layout.stop();assert.equal(observers[0].disconnected,true);
  track.cues[0].position=98;track.dispatchEvent(new Event('cuechange'));video.dispatchEvent(new Event('resize'));observers[0].callback();
  assert.equal(track.cues[0].position,98,'Stopping removes track, media and observer effects.');
});

test('switching sessions detaches the old track list and does not share local subtitle state',()=>{
  const oldTrack=new Track(),video=new Video([oldTrack]),layout=new SubtitleLayout({video,getControlsRoot:()=>null});layout.attach();
  const oldList=video.textTracks,newTrack=new Track('subtitles',[cue('Nova sessão')]);video.textTracks=new TrackList([newTrack]);layout.attach();
  assert.equal(newTrack.cues[0].position,50);assert.equal(newTrack.mode,'showing');
  oldTrack.cues[0].position=99;oldTrack.dispatchEvent(new Event('cuechange'));oldList.dispatchEvent(new Event('change'));assert.equal(oldTrack.cues[0].position,99);
  layout.stop();assert.equal(layout.tracks.size,0);assert.equal(layout.disposers.length,0);
});
