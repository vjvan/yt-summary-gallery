/* eslint-disable @typescript-eslint/no-require-imports -- This Node CommonJS test evaluates transpiled CommonJS modules in an isolated VM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Error, process: { env: {} }, require(name) {
    if (name in mocks) return mocks[name];
    throw new Error('Unmocked dependency: ' + name);
  } });
  return exports;
}
const media = load(path.join(__dirname, '../lib/media-export-client.ts'), {});
function fixture(error) {
  let calls = 0, copyAttempts = 0;
  const subject = load(path.join(__dirname, '../lib/pipeline/fetch-video-url.ts'), {
    path,
    fs: { existsSync: () => true, mkdirSync() {}, copyFileSync() { copyAttempts++; } },
    './run-command': { run: async () => { calls++; throw error; } },
    '../media-export-client': media,
  });
  return { execute: () => subject.fetchVideoFromUrl('https://www.youtube.com/watch?v=qVWfoe0voIk', 'qVWfoe0voIk', '/mock-only'), stats: () => ({ calls, copyAttempts }) };
}

test('the old 300-character crop loses a real-shaped downstream 403', () => {
  const root = '/Users/vjvan/yt-summary-gallery';
  const id = 'qVWfoe0voIk';
  const command = `"/opt/homebrew/bin/yt-dlp" -f "best[ext=mp4]/best" --no-playlist --write-info-json --merge-output-format mp4 --no-warnings -o "${root}/data/tmp/${id}/${id}.%(ext)s" "https://www.youtube.com/watch?v=${id}"`;
  const raw = `Command failed: ${command}\nERROR: unable to download video data: HTTP Error 403: Forbidden\n`;
  assert.ok(raw.indexOf('403') >= 300);
  assert.doesNotMatch(media.mediaFailureMessage(raw.slice(0, 300), 'download'), /403/);
});

test('structured stderr retains a late 403, hides secrets, and runs only once', async () => {
  const error = Object.assign(new Error('Command failed: ' + 'long-path/'.repeat(80) + '\nERROR: HTTP Error 403: Forbidden'), {
    stderr: 'ERROR: unable to download video data: HTTP Error 403: Forbidden https://cdn.invalid/?signature=DO_NOT_LEAK',
  });
  const input = fixture(error);
  await assert.rejects(input.execute, failure => {
    assert.match(failure.message, /403.*不會繞過/);
    assert.doesNotMatch(failure.message, /https:|signature|DO_NOT_LEAK|long-path/);
    return true;
  });
  assert.deepEqual(input.stats(), { calls: 1, copyAttempts: 0 });
});

test('stderr takes precedence over 403 text in command arguments', async () => {
  const error = Object.assign(new Error('Command failed: tool https://example.invalid/403'), { stderr: 'ERROR: requested format is not available' });
  await assert.rejects(fixture(error).execute, failure => {
    assert.doesNotMatch(failure.message, /403|https:|example/);
    assert.match(failure.message, /原片下載失敗/);
    return true;
  });
});

test('message-only process errors still classify without exposing raw details', async () => {
  await assert.rejects(fixture(new Error('Sign in to confirm https://private.invalid/?token=SECRET')).execute, failure => {
    assert.match(failure.message, /登入限制/);
    assert.doesNotMatch(failure.message, /SECRET|https:/);
    return true;
  });
});

test('unknown failures remain safe, do not coerce arbitrary objects, and do not retry', async () => {
  const input = fixture({ toString() { throw new Error('must not stringify unknown failure'); } });
  await assert.rejects(input.execute, /原片下載失敗/);
  assert.deepEqual(input.stats(), { calls: 1, copyAttempts: 0 });
});
