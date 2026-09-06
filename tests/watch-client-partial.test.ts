import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedWatchCues } from '../lib/watch/client-results';
import { watchScheduleDecision } from '../lib/watch/full-prefetch';
import { watchClientFailure } from '../lib/watch/client-state';
const cues = Array.from({length:24},(_,i)=>({id:`c${i}`,start:i*5,end:i*5+4,text:`source ${i}`}));
const base={mode:'full' as const,processingMode:'local' as const,cues,time:0,completed:new Set<number>(),failed:new Map(),consent:true,enabled:true,playing:false,stopped:false,pending:null,failure:null,retryRequested:false};
test('cached or partial cue results must match id, timestamps, original text, and nonempty translation',()=>{
 const valid={...cues[0],originalText:cues[0].text,text:'中文'};
 assert.deepEqual(verifiedWatchCues(cues,[valid,valid]),[valid]);
 for(const invalid of [{...valid,id:'wrong'},{...valid,start:8},{...valid,end:9},{...valid,originalText:'other'},{...valid,text:' '},{...valid,text:'x'.repeat(8001)},{...valid,text:'a\nb'},null,{}]) assert.deepEqual(verifiedWatchCues(cues,[invalid]),[]);
 assert.deepEqual(verifiedWatchCues(cues,null),[]);
});
test('isolated quality block does not lose success or halt remaining full prefetch while paused',()=>{
 const failure=watchClientFailure(0,'One cue failed',502,'LOCAL_TRANSLATION_QUALITY');const failed=new Map([[0,failure]]);
 assert.deepEqual(watchScheduleDecision({...base,failure,failed}),{kind:'dispatch',block:1});
 assert.deepEqual(watchScheduleDecision({...base,failure,failed,time:100}),{kind:'dispatch',block:2});
 assert.deepEqual(watchScheduleDecision({...base,failure,failed,completed:new Set([1,2])}),{kind:'blocked'});
 assert.deepEqual(watchScheduleDecision({...base,failure,failed,completed:new Set([1,2]),retryRequested:true}),{kind:'dispatch',block:0});
 assert.deepEqual(watchScheduleDecision({...base,completed:new Set([0,1,2])}),{kind:'done'});
});
test('partial full mode retains all existing stop/cloud/transport gates',()=>{
 const failure=watchClientFailure(0,'bad',502,'LOCAL_TRANSLATION_QUALITY');const failed=new Map([[0,failure]]);
 for(const change of [{consent:false},{enabled:false},{stopped:true},{pending:{}},{processingMode:'cloud' as const}])assert.deepEqual(watchScheduleDecision({...base,failure,failed,...change}),{kind:'idle'});
 for(const code of ['MODEL_FAILED','LOCAL_MODEL_TIMEOUT','LOCAL_MODEL_FAILED'])assert.deepEqual(watchScheduleDecision({...base,failure:watchClientFailure(0,'bad',502,code),failed}),{kind:'idle'});
});
