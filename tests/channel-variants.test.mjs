import test from 'node:test';
import assert from 'node:assert/strict';
import {channelFamily, channelQualityRank, channelCodec, findChannelVariants, declaredSourceBitrate, sourceDecodingConfiguration, measuredQualityLabel} from '../web/channel-variants.js';

const channel=(id,name,extra={})=>({id:String(id),name,kind:'live',...extra});

test('quality families normalize delivery tags and numeric resolutions while retaining regional identity',()=>{
  const current=channel(1,'Globo Sergipe HD');
  const offered=[current,channel(2,'GLOBO – SÉRGIPE [2160p] HEVC H.265'),channel(3,'Globo Sergipe 1080p'),channel(4,'Globo Alagoas 4K'),channel(5,'Globo São Paulo HD')];
  assert.deepEqual(findChannelVariants(current,offered).map(item=>item.id),['1','2','3']);
  assert.equal(channelFamily('SporTV 1 4K'),'sportv');
  assert.equal(channelFamily('RedeTV! FHD'),'rede tv');
  assert.equal(channelCodec(offered[1]),'hevc');
  assert.equal(channelQualityRank(offered[1]),2160);
  assert.equal(channelQualityRank(channel(9,'Globo Sergipe HD FHD')),null);
});

test('channel numbers, cameras and positive time shifts are never merged',()=>{
  for(const [first,second]of [['SporTV 2 HD','SporTV 3 FHD'],['BBC One +2 HD','BBC One 2 4K'],['BBC One +2 HD','BBC One HD'],['BBB Câmera 1 HD','BBB Câmera 2 FHD']]) {
    assert.notEqual(channelFamily(first),channelFamily(second));
    assert.equal(findChannelVariants(channel(1,first),[channel(2,second)]).length,0);
  }
});

test('late 4K sources remain selectable in the full catalog with duplicate IDs removed',()=>{
  const entries=[...Array.from({length:15},(_,i)=>channel(i,`Canal Sergipe ${i%2?'HD':'FHD'}`)),channel(20,'Canal Sergipe 4K HEVC')];
  const result=findChannelVariants(entries[0],[...entries,entries[0]]);
  assert.equal(result.length,16);assert.equal(result.at(-1).id,'20');
  assert.equal(findChannelVariants({...entries[0],kind:'movie'},entries).length,0);
});

test('decoding capability checks require real codec profile, size, rate and bitrate units',()=>{
  const complete=channel(1,'Canal 4K HEVC',{bitrateBps:20000000,source:{videoCodec:'hvc1.1.6.L153.B0',width:3840,height:2160,frameRate:60}});
  assert.deepEqual(sourceDecodingConfiguration(complete),{type:'media-source',video:{contentType:'video/mp4; codecs="hvc1.1.6.L153.B0"',width:3840,height:2160,bitrate:20000000,framerate:60}});
  assert.equal(sourceDecodingConfiguration(channel(2,'Canal 4K HEVC')),null);
  for(const source of [{...complete.source,videoCodec:'hevc'},{...complete.source,width:true},{...complete.source,frameRate:undefined}])assert.equal(sourceDecodingConfiguration({...complete,source}),null);
  assert.equal(declaredSourceBitrate({...complete,bitrateBps:undefined,bitrate:20}),null);
  assert.equal(declaredSourceBitrate({...complete,bitrateBps:true}),null);
});

test('quality labels distinguish declared levels from measured 4K dimensions',()=>{
  assert.equal(measuredQualityLabel(2160),'2160p · 4K');
  assert.equal(measuredQualityLabel(2160,3840),'2160p · 4K');
  assert.equal(measuredQualityLabel(2160,1920),'2160p');
  assert.equal(measuredQualityLabel(1080,3840),'1080p');
  assert.equal(measuredQualityLabel(1080),'1080p');
  for(const value of [undefined,null,0,'4K','2160',NaN])assert.equal(measuredQualityLabel(value),'');
});
