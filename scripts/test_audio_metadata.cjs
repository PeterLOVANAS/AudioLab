/** Focused WAV extraction and Task Instance → Workspace metadata contract. */
const fs=require('node:fs'),ts=require('@typescript/typescript6'),assert=require('node:assert/strict');
function load(path){const m={exports:{}};new Function('exports','module',ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,m);return m.exports;}
const {readWavMetadata}=load('lib/audio/wav-metadata.ts');
function wav(channels=1){const b=Buffer.alloc(54+32000*channels);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEJUNK',8);b.writeUInt32LE(1,16);b.write('fmt ',22);b.writeUInt32LE(16,26);b.writeUInt16LE(1,30);b.writeUInt16LE(channels,32);b.writeUInt32LE(16000,34);b.writeUInt32LE(32000*channels,38);b.writeUInt16LE(2*channels,42);b.writeUInt16LE(16,44);b.write('data',46);b.writeUInt32LE(32000*channels,50);return b;}
for(const n of [1,2]){const b=wav(n);assert.deepEqual(readWavMetadata(b),{durationSeconds:1,sampleRate:16000,channels:n});assert.equal(readWavMetadata(b.subarray(0,54),b.length).durationSeconds,1);}
assert.throws(()=>readWavMetadata(Buffer.alloc(12)));assert.throws(()=>readWavMetadata(wav().subarray(0,54)));assert.throws(()=>readWavMetadata(wav().subarray(0,30),32054));
const {toLabellerSamples}=load('lib/frontend/labeller-samples.ts');
const samples=toLabellerSamples({assetId:'a',audioUrl:'/a',audioAssets:[{id:'a',url:'/a',position:0,durationSeconds:1,sampleRate:16000,channels:2}]},[]);
assert.deepEqual(samples.primaryMeta,{durationSeconds:1,sampleRate:16000,channels:2});
assert.equal(toLabellerSamples({assetId:'a',audioUrl:'/a'},[]).primaryMeta,undefined);
console.log('PASS mono/stereo, padded chunks, bounded header reads, malformed/truncated WAV rejection and Workspace metadata propagation.');
