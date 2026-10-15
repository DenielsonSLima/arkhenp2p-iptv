import test from 'node:test';
import assert from 'node:assert/strict';
import { ResumePrompt } from '../web/resume-prompt.js';

class Element extends EventTarget {append(){}remove(){}}
function setup(){
  const video=Object.assign(new EventTarget(),{currentTime:0,paused:false,seeking:false,readyState:2});
  const jobs=new Map();let id=0,restarts=0;
  const prompt=new ResumePrompt({video,document:{createElement:()=>new Element()},onRestart:()=>restarts++,setTimer:(fn,delay)=>{jobs.set(++id,{fn,delay});return id;},clearTimer:id=>jobs.delete(id)});
  return {video,prompt,jobs,get restarts(){return restarts;}};
}
test('resume offer waits for actual playback at the saved time and lasts five seconds',()=>{
  const {video,prompt,jobs}=setup();prompt.attach({time:600});
  video.dispatchEvent(new Event('playing'));assert.equal(prompt.root.hidden,true);assert.equal(jobs.size,0);
  video.currentTime=600;video.seeking=true;video.dispatchEvent(new Event('timeupdate'));assert.equal(prompt.root.hidden,true);
  video.seeking=false;video.dispatchEvent(new Event('seeked'));assert.equal(prompt.root.hidden,false);
  const job=[...jobs.values()][0];assert.equal(job.delay,5000);
  video.dispatchEvent(new Event('timeupdate'));assert.equal(jobs.size,1);
  job.fn();assert.equal(prompt.root.hidden,true);
});
test('reset and source changes cancel stale timers and prevent a delayed offer',()=>{
  const {video,prompt,jobs}=setup();prompt.attach({time:10});video.currentTime=10;prompt.update();
  const old=[...jobs.values()][0];prompt.attach({time:60});old.fn();
  video.currentTime=60;prompt.update();assert.equal(prompt.root.hidden,false);
  prompt.reset();video.dispatchEvent(new Event('playing'));assert.equal(prompt.root.hidden,true);assert.equal(jobs.size,0);
});
test('new playback has no resume offer; starting over fires once and dismisses',()=>{
  const state=setup();state.prompt.attach({time:0});state.prompt.update();assert.equal(state.prompt.root.hidden,true);
  state.prompt.attach({time:120});state.video.currentTime=120;state.prompt.update();
  state.prompt.button.dispatchEvent(new Event('click'));state.prompt.button.dispatchEvent(new Event('click'));
  assert.equal(state.restarts,1);assert.equal(state.prompt.root.hidden,true);assert.equal(state.jobs.size,0);
});
test('focused resume action remains usable with keyboard and expires after focus leaves',()=>{
  const {video,prompt,jobs}=setup();prompt.attach({time:120});video.currentTime=120;prompt.update();
  prompt.button.dispatchEvent(new Event('focus'));assert.equal(jobs.size,0);assert.equal(prompt.root.hidden,false);
  prompt.button.dispatchEvent(new Event('blur'));assert.equal([...jobs.values()][0].delay,5000);
  prompt.destroy();assert.equal(jobs.size,0);
});
