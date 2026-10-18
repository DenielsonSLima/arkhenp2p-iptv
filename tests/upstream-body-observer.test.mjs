import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readBody} from '../lib/upstream.mjs';

test('an optional first-body observer sees the existing bytes without consuming or changing their bound',async()=>{
  const body=Buffer.from('#EXTM3U\n# comentário UTF-8\n');let measured=0;
  const result=await readBody({body:Readable.from([body.subarray(0,5),body.subarray(5)])},body.length,chunk=>{measured+=chunk.length;});
  assert.deepEqual(result,body);assert.equal(measured,body.length);
  await assert.rejects(()=>readBody({body:Readable.from([body])},body.length-1,()=>{}),/excedeu/);
});
