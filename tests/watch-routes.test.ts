import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchService } from '../lib/watch/service';
import { WatchStore } from '../lib/watch/store';
import { pairingToken } from '../lib/watch/security';
import { withVideoTermbase } from '../lib/watch/termbase';
import { POST as startRoute, OPTIONS } from '../app/api/watch/session/route';
import { POST as windowRoute } from '../app/api/watch/window/route';
import { POST as stopRoute } from '../app/api/watch/session/[id]/stop/route';
import { GET as pairRoute } from '../app/api/watch/pair/route';
import { GET as jobRoute, DELETE as cancelJobRoute } from '../app/api/watch/jobs/[id]/route';

test('video termbase supplements defaults but preserves user-edited translations', () => {
  const original = { no_translate_terms: ['Figma'], term_map: [['MASK', '使用者遮罩']] as [string,string][], style_rules: [] };
  const result = withVideoTermbase(original);
  assert.equal(result.term_map.find(([en]) => en.toLowerCase() === 'mask')?.[1], '使用者遮罩');
  assert.ok(result.term_map.some(([en]) => en === 'compositor node'));
  assert.equal(original.term_map.length, 1);
});

test('route contract: pairing → source → incremental translation → stop (mock model/source only)', async () => {
  const store = new WatchStore(':memory:');
  let calls = 0;
  const service = new WatchService({ store, provider: () => ({ processingMode: 'local', unlimited: true, translationModel: 'mock-local', translationConfigured: true, audioConfigured: false }), source: async () => ({ videoId: 'kfbWz9_bJoA', title: 'Mock route fixture', language: 'en', sourceKind: 'manual', trackId: 'fixture', cues: [{id:'cue-0',start:0,end:4,text:'The compositor node.'}] }),
    translate: async ({targets}) => {calls++; return targets.map(cue=>({...cue,originalText:cue.text,text:'合成器節點。'}));},
    glossary: () => ({no_translate_terms:[],term_map:[],style_rules:[]}), enabled: () => true, limits: () => ({sessionCalls:25,dailyCalls:100}),
  });
  const global = globalThis as typeof globalThis & { __ytWatchService?: WatchService };
  const previous = global.__ytWatchService;
  global.__ytWatchService = service;
  const token = pairingToken();
  const req = (path: string, body: unknown, origin = 'http://127.0.0.1:3000', authorized = true) => new Request(`http://127.0.0.1:3000/api/watch/${path}`, { method:'POST', headers:{'content-type':'application/json',origin,...(authorized ? {authorization:`Bearer ${token}`} : {})},body:JSON.stringify(body)});
  try {
    assert.equal((await pairRoute(new Request('http://127.0.0.1:3000/api/watch/pair',{headers:{origin:'https://evil.example'}}))).status,403);
    assert.equal((await startRoute(req('session',{url:'https://youtu.be/kfbWz9_bJoA'},'http://127.0.0.1:3000',false))).status,401);
    assert.equal((await startRoute(req('session',{url:'https://youtu.be/kfbWz9_bJoA'},'https://evil.example'))).status,403);
    const extension = `chrome-extension://${'b'.repeat(32)}`;
    const preflight = await OPTIONS(new Request('http://127.0.0.1:3000/api/watch/session',{method:'OPTIONS',headers:{origin:extension}}));
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),extension);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers')!, /Prefer/);
    assert.match(preflight.headers.get('Access-Control-Allow-Methods')!, /GET.*DELETE/);
    const started = await startRoute(req('session',{url:'https://youtu.be/kfbWz9_bJoA'},extension));
    assert.equal(started.status,200);
    const session = await started.json();
    assert.equal(session.cues.length,1);
    assert.equal(calls,0);
    assert.equal((await windowRoute(req('window',{sessionId:session.sessionId,time:0}))).status,403);
    const translated = await windowRoute(req('window',{sessionId:session.sessionId,time:0,confirmTranslation:true}));
    assert.equal(translated.status,200);
    assert.equal((await translated.json()).cues[0].text,'合成器節點。');
    assert.equal(calls,1);
    await stopRoute(req(`session/${session.sessionId}/stop`,{}),{params:Promise.resolve({id:session.sessionId})});
    assert.equal((await windowRoute(req('window',{sessionId:session.sessionId,time:0,confirmTranslation:true}))).status,410);

    // Exercise the real async route contract used by Chrome, not just the job store.
    const asyncStart = req('session',{url:'https://youtu.be/kfbWz9_bJoA'},extension);
    asyncStart.headers.set('Prefer','respond-async');
    const accepted = await startRoute(asyncStart);
    assert.equal(accepted.status,202);
    const sourceJob = await accepted.json();
    const jobRequest = (id:string,method='GET',authorized=true) => new Request(`http://127.0.0.1:3000/api/watch/jobs/${id}`,{method,headers:{origin:extension,...(authorized?{authorization:`Bearer ${token}`}:{})}});
    const context = (id:string) => ({params:Promise.resolve({id})});
    assert.equal((await jobRoute(jobRequest(sourceJob.jobId,'GET',false),context(sourceJob.jobId))).status,401);
    const poll = async (id:string) => {
      for(let attempt=0;attempt<10;attempt++) {
        const response = await jobRoute(jobRequest(id),context(id));
        if(response.status!==202) {assert.equal(response.status,200);return response.json();}
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      throw new Error('Mock async job did not complete');
    };
    const sourceResult = await poll(sourceJob.jobId);
    assert.equal(sourceResult.status,'done');
    const asyncWindow = req('window',{sessionId:sourceResult.result.sessionId,time:0,confirmTranslation:true},extension);
    asyncWindow.headers.set('Prefer','respond-async');
    const windowAccepted = await windowRoute(asyncWindow);
    assert.equal(windowAccepted.status,202);
    const windowJob = await windowAccepted.json();
    assert.equal((await poll(windowJob.jobId)).result.cues[0].text,'合成器節點。');
    assert.equal(calls,1,'async route reuses the existing translated window cache');
    assert.equal((await cancelJobRoute(jobRequest(sourceJob.jobId,'DELETE'),context(sourceJob.jobId))).status,200);
    assert.equal((await jobRoute(jobRequest(sourceJob.jobId),context(sourceJob.jobId))).status,410);
    assert.equal((await windowRoute(req('window',{sessionId:sourceResult.result.sessionId,time:0,confirmTranslation:true}))).status,410);
    await cancelJobRoute(jobRequest(windowJob.jobId,'DELETE'),context(windowJob.jobId));
  } finally {global.__ytWatchService=previous;store.close();}
});
