import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('library retry publishes processing before delayed source fetch and releases it on failure', () => {
  const library = pathToFileURL(path.resolve('lib/pipeline/local-youtube-library.ts')).href;
  const database = pathToFileURL(path.resolve('lib/db.ts')).href;
  const script = `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-state-test-')); process.chdir(temp);
    const { getDb } = await import(${JSON.stringify(database)});
    const { startLocalYoutubeLibrary, ensureLibrarySubtitleColumns } = await import(${JSON.stringify(library)});
    const db = getDb(); ensureLibrarySubtitleColumns();
    db.prepare("INSERT INTO summaries(id,video_id,url,status,summary,card_paths,subtitle_status) VALUES('test','N-tmQ_Can_o','https://youtu.be/N-tmQ_Can_o','done','{}','[]','partial')").run();
    let rejectSource;
    globalThis.__ytWatchService = { start: () => new Promise((_, reject) => { rejectSource = reject; }), stop: () => {} };
    const job = startLocalYoutubeLibrary('test', 'https://youtu.be/N-tmQ_Can_o');
    assert.equal(db.prepare("SELECT subtitle_status FROM summaries WHERE id='test'").get().subtitle_status, 'processing');
    rejectSource(new Error('mock delayed source failure')); await job;
    assert.equal(db.prepare("SELECT subtitle_status FROM summaries WHERE id='test'").get().subtitle_status, 'error');
    const retained = db.prepare("SELECT status,error,summary,card_paths FROM summaries WHERE id='test'").get();
    assert.equal(retained.status, 'done'); assert.equal(retained.error, null);
    assert.equal(retained.summary, '{}'); assert.equal(retained.card_paths, '[]');
    db.close(); fs.rmSync(temp, { recursive: true, force: true });
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, WATCH_PROCESSING_MODE: 'local' } });
  assert.equal(result.status, 0, result.stderr);
});

test('PNG renderer failure retains a text summary, completes subtitle windows, and retries cards without model/source work', () => {
  const library = pathToFileURL(path.resolve('lib/pipeline/local-youtube-library.ts')).href;
  const database = pathToFileURL(path.resolve('lib/db.ts')).href;
  const script = `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-render-test-')); process.chdir(temp);
    const { getDb } = await import(${JSON.stringify(database)});
    const { runLocalYoutubeLibrary, ensureLibrarySubtitleColumns, libraryCardsReady } = await import(${JSON.stringify(library)});
    const db = getDb(); ensureLibrarySubtitleColumns();
    db.prepare("INSERT INTO summaries(id,video_id,url,status,subtitle_status) VALUES('test','N-tmQ_Can_o','https://youtu.be/N-tmQ_Can_o','processing','processing')").run();
    const cues = Array.from({length:9}, (_, index) => ({id:String(index),start:index,end:index+1,text:'Original cue '+index}));
    const translated = cues.map(cue => ({...cue,originalText:cue.text,text:'中文段落'+cue.id}));
    let starts=0, windows=0, summaries=0, renders=0;
    globalThis.__ytWatchService = {
      start: async () => { starts++; return {videoId:'N-tmQ_Can_o',title:'Unit test',language:'en',sourceKind:'manual',trackId:'track',cues,sessionId:'session',processingMode:'local',cachedCues:[]}; },
      window: async (_, time) => { windows++; const start=Math.floor(time/8)*8; return {cues:translated.slice(start,start+8),complete:true}; }, stop: () => {}
    };
    const summary={title_display:'文字摘要',one_liner:'重點',tldr_paragraph:'這是已保存的摘要文字。',key_points:[],key_quote:'',action_items:[],pitfalls:[],recall_questions:[],tags:[],highlights:[],video_genre:'other'};
    await runLocalYoutubeLibrary('test','https://youtu.be/N-tmQ_Can_o', {
      summarize: async () => { summaries++; return summary; },
      render: async () => { renders++; throw new Error('Chromium denied, secret command'); }
    });
    const first = db.prepare("SELECT * FROM summaries WHERE id='test'").get();
    assert.equal(first.status,'done'); assert.equal(JSON.parse(first.summary).title_display,'文字摘要');
    assert.equal(first.subtitle_status,'complete'); assert.equal(first.subtitle_completed,9); assert.equal(first.subtitle_total,9);
    assert.equal(first.is_translated,1); assert.equal(JSON.parse(first.segments_zh).length,9);
    assert.equal(first.card_paths,null); assert.match(first.error,/圖卡繪製/); assert.doesNotMatch(first.error,/Ollama|secret command/);
    assert.equal(windows,2); assert.equal(summaries,1); assert.equal(renders,1);
    assert.ok(fs.existsSync(path.join(temp,'public',first.srt_zh_path)));
    const savedStyle={palette:'forest-cream',fontPreset:'round-display',background:'paper-fiber'};
    db.prepare('UPDATE summaries SET card_style=?').run(JSON.stringify(savedStyle));
    await runLocalYoutubeLibrary('test','https://youtu.be/N-tmQ_Can_o', {
      summarize: async () => { throw new Error('must not summarize again'); },
      render: async (_summary,_metadata,_dir,style) => { assert.deepEqual(style,savedStyle); renders++; return ['rendered-card.png']; }
    });
    const second=db.prepare("SELECT * FROM summaries WHERE id='test'").get();
    assert.equal(starts,1); assert.equal(windows,2); assert.equal(summaries,1); assert.equal(renders,2);
    assert.equal(second.error,null); assert.equal(second.status,'done'); assert.equal(second.subtitle_status,'complete');
    assert.equal(JSON.parse(second.card_paths).length,1); assert.equal(second.segments_zh,first.segments_zh);
    assert.equal(libraryCardsReady(second.card_paths),true); assert.equal(libraryCardsReady('[]'),false); assert.equal(libraryCardsReady(null),false);
    db.close(); fs.rmSync(temp,{recursive:true,force:true});
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, WATCH_PROCESSING_MODE: 'local' } });
  assert.equal(result.status, 0, result.stderr);
});

test('restart ends an interrupted card-only retry without downgrading complete subtitles or restarting inference', () => {
  const library = pathToFileURL(path.resolve('lib/pipeline/local-youtube-library.ts')).href;
  const database = pathToFileURL(path.resolve('lib/db.ts')).href;
  const script = `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'library-render-restart-')); process.chdir(temp);
    const { getDb }=await import(${JSON.stringify(database)});
    const { ensureLibrarySubtitleColumns, recoverLocalLibraryJobs }=await import(${JSON.stringify(library)});
    const db=getDb(); ensureLibrarySubtitleColumns();
    const insert=db.prepare("INSERT INTO summaries(id,video_id,url,status,pipeline_stage,summary,subtitle_status,subtitle_completed,subtitle_total,segments_zh,is_translated,srt_zh_path,srt_bi_path) VALUES(?,?,'https://youtu.be/N-tmQ_Can_o','done',?,'{}',?,9,9,'[]',1,'/burned/test.zh.srt','/burned/test.bi.srt')");
    insert.run('interrupted','video1','library_rendering','complete');
    insert.run('ready','video2','done','complete');
    insert.run('subtitles','video3','summary_ready','processing');
    insert.run('rendering-subtitles','video4','library_rendering','processing');
    insert.run('no-summary','video5','library_rendering','processing');
    insert.run('null-status','video6','library_rendering',null);
    insert.run('partial-status','video7','library_rendering','partial');
    insert.run('error-status','video8','library_rendering','error');
    insert.run('token-owned','video9','done','complete');
    db.prepare("UPDATE summaries SET card_render_token='interrupted-owned-token' WHERE id='token-owned'").run();
    const savedStyle=JSON.stringify({palette:'forest-cream',fontPreset:'bold-statement',background:'paper-fiber'});
    db.prepare("UPDATE summaries SET card_style=?,card_paths=?").run(savedStyle,JSON.stringify(["/cards/old.png"]));
    db.prepare("UPDATE summaries SET summary=?,segments_zh=?").run(JSON.stringify({title_display:'已完成摘要'}),JSON.stringify([{text:'已完成字幕'}]));
    db.prepare("UPDATE summaries SET summary=NULL,status='processing' WHERE id='no-summary'").run();
    let modelCalls=0;
    globalThis.fetch=async()=>{modelCalls++;throw new Error('must not infer on recovery');};
    recoverLocalLibraryJobs();
    const fixed=db.prepare("SELECT * FROM summaries WHERE id='interrupted'").get();
    assert.equal(fixed.status,'done'); assert.equal(fixed.pipeline_stage,'library_render_error');
    assert.equal(fixed.subtitle_status,'complete'); assert.equal(fixed.subtitle_completed,9); assert.equal(fixed.subtitle_total,9);
    assert.equal(fixed.card_style,savedStyle); assert.equal(fixed.card_paths,'[\"/cards/old.png\"]');
    for (const key of ['null-status','partial-status','error-status','token-owned']) {
      const old=db.prepare('SELECT * FROM summaries WHERE id=?').get(key);
      assert.equal(old.pipeline_stage,'library_render_error'); assert.equal(old.card_render_token,null); assert.equal(old.card_style,savedStyle);
      assert.equal(old.card_paths,'[\"/cards/old.png\"]');
    }
    assert.equal(fixed.is_translated,1); assert.equal(fixed.srt_zh_path,'/burned/test.zh.srt'); assert.equal(fixed.srt_bi_path,'/burned/test.bi.srt');
    assert.equal(JSON.parse(fixed.summary).title_display,'已完成摘要'); assert.equal(JSON.parse(fixed.segments_zh)[0].text,'已完成字幕');
    assert.match(fixed.error,/圖卡繪製.*重新啟動/); assert.equal(fixed.subtitle_error,null); assert.equal(modelCalls,0);
    assert.equal(db.prepare("SELECT error FROM summaries WHERE id='ready'").get().error,null);
    assert.equal(db.prepare("SELECT subtitle_status FROM summaries WHERE id='subtitles'").get().subtitle_status,'error');
    const rendering=db.prepare("SELECT * FROM summaries WHERE id='rendering-subtitles'").get();
    assert.equal(rendering.status,'done'); assert.equal(rendering.pipeline_stage,'library_render_error');
    assert.equal(rendering.subtitle_status,'error'); assert.match(rendering.subtitle_error,/重新啟動/);
    assert.equal(JSON.parse(rendering.summary).title_display,'已完成摘要');
    assert.equal(JSON.parse(rendering.segments_zh)[0].text,'已完成字幕');
    const noSummary=db.prepare("SELECT * FROM summaries WHERE id='no-summary'").get();
    assert.equal(noSummary.status,'error'); assert.equal(noSummary.pipeline_stage,'error');
    assert.equal(noSummary.subtitle_status,'error'); assert.equal(noSummary.summary,null);
    db.close(); fs.rmSync(temp,{recursive:true,force:true});
  `;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',timeout:15_000,env:{...process.env,WATCH_PROCESSING_MODE:'local'}});
  assert.equal(result.status,0,result.stderr);
});
