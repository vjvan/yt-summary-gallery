import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import ts from 'typescript';
import { generatedMediaRange, serveGeneratedMedia, type GeneratedMediaKind } from '../lib/generated-media';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generated-media-'));
  try {
    for (const kind of ['cards', 'burned', 'videos', 'audio']) await fs.mkdir(path.join(root, 'public', kind), { recursive: true });
    await run(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const req = (pathname: string, init?: RequestInit) => new Request(`http://localhost:3000${pathname}`, init);

test('files generated after a first 404 are immediately readable; no startup list or stale body', async () => {
  await fixture(async root => {
    const parts = ['video-id', 'slide-1.png'];
    assert.equal((await serveGeneratedMedia(req('/cards/video-id/slide-1.png'), 'cards', parts, root)).status, 404);
    await fs.mkdir(path.join(root, 'public/cards/video-id'));
    await fs.writeFile(path.join(root, 'public/cards/video-id/slide-1.png'), 'first-card');
    const first = await serveGeneratedMedia(req('/cards/video-id/slide-1.png'), 'cards', parts, root);
    assert.equal(first.status, 200); assert.equal(await first.text(), 'first-card');
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    await fs.writeFile(path.join(root, 'public/cards/video-id/slide-1.png'), 'new-card');
    assert.equal(await (await serveGeneratedMedia(req('/cards/video-id/slide-1.png'), 'cards', parts, root)).text(), 'new-card');
  });
});

test('subtitle, uploaded video/audio and nested remix roots have the correct allowlisted MIME', async () => {
  await fixture(async root => {
    for (const [kind, name, type] of [
      ['burned', 'clip.zh.srt', 'application/x-subrip; charset=utf-8'], ['burned', 'clip.zh.vtt', 'text/vtt; charset=utf-8'],
      ['burned', 'clip.mp4', 'video/mp4'], ['videos', 'clip.mov', 'video/quicktime'], ['videos', 'clip.mkv', 'video/x-matroska'],
      ['videos', 'clip.webm', 'video/webm'], ['videos', 'clip.m4v', 'video/x-m4v'], ['videos', 'clip.avi', 'video/x-msvideo'],
      ['audio', 'clip.mp3', 'audio/mpeg'], ['audio', 'clip.m4a', 'audio/mp4'], ['audio', 'clip.wav', 'audio/wav'],
      ['audio', 'clip.ogg', 'audio/ogg'], ['audio', 'clip.opus', 'audio/ogg'], ['audio', 'clip.aac', 'audio/aac'], ['audio', 'clip.flac', 'audio/flac'],
    ] as const) {
      await fs.writeFile(path.join(root, 'public', kind, name), '媒體 fixture');
      const response = await serveGeneratedMedia(req(`/${kind}/${name}`), kind, [name], root);
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), type);
      assert.equal(await response.text(), '媒體 fixture');
      if (name.endsWith('.srt')) assert.match(response.headers.get('content-disposition')!, /attachment; filename="clip.zh.srt"/);
    }
    await fs.mkdir(path.join(root, 'public/videos/project-123'));
    await fs.writeFile(path.join(root, 'public/videos/project-123/remix.mp4'), 'remix');
    assert.equal(await (await serveGeneratedMedia(req('/videos/project-123/remix.mp4'), 'videos', ['project-123', 'remix.mp4'], root)).text(), 'remix');
  });
});

test('MP4 streams byte ranges, suffixes, open ends, If-Range and HEAD without buffering the entire file', async () => {
  await fixture(async root => {
    await fs.writeFile(path.join(root, 'public/videos/movie.mp4'), '0123456789');
    for (const [range, expected, contentRange] of [
      ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10'], ['bytes=-100', '0123456789', 'bytes 0-9/10'],
    ]) {
      const response = await serveGeneratedMedia(req('/videos/movie.mp4', { headers: { range } }), 'videos', ['movie.mp4'], root);
      assert.equal(response.status, 206); assert.equal(await response.text(), expected);
      assert.equal(response.headers.get('content-range'), contentRange); assert.equal(Number(response.headers.get('content-length')), expected.length);
    }
    const head = await serveGeneratedMedia(req('/videos/movie.mp4', { method: 'HEAD', headers: { range: 'bytes=2-5' } }), 'videos', ['movie.mp4'], root);
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
    const stale = await serveGeneratedMedia(req('/videos/movie.mp4', { headers: { range: 'bytes=2-5', 'if-range': '"old-validator"' } }), 'videos', ['movie.mp4'], root);
    assert.equal(stale.status, 200); assert.equal(await stale.text(), '0123456789');
    const valid = await serveGeneratedMedia(req('/videos/movie.mp4', { headers: { range: 'bytes=2-5', 'if-range': head.headers.get('last-modified')! } }), 'videos', ['movie.mp4'], root);
    assert.equal(valid.status, 206); assert.equal(await valid.text(), '2345');
  });
});

test('invalid/multiple/unsatisfiable ranges return 416 and disclose only public file length', async () => {
  await fixture(async root => {
    await fs.writeFile(path.join(root, 'public/burned/movie.mp4'), '0123456789');
    for (const range of ['bytes=10-', 'bytes=9-1', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'bytes=99999999999999999999-', 'items=0-2']) {
      const response = await serveGeneratedMedia(req('/burned/movie.mp4', { headers: { range } }), 'burned', ['movie.mp4'], root);
      assert.equal(response.status, 416, range); assert.equal(response.headers.get('content-range'), 'bytes */10'); assert.equal(await response.text(), '');
    }
    assert.deepEqual(generatedMediaRange('bytes=0-0', 10), { start: 0, end: 0 });
    assert.equal(generatedMediaRange('bytes=0-', 0), null);
  });
});

test('reject traversal, encoded/double-encoded separators, hidden paths, unsupported roots/extensions and directories', async () => {
  await fixture(async root => {
    await fs.writeFile(path.join(root, 'private.png'), 'private');
    await fs.writeFile(path.join(root, 'public/cards/secret.html'), '<script>secret</script>');
    await fs.mkdir(path.join(root, 'public/cards/folder.png'));
    for (const parts of [[], ['..', 'private.png'], ['.'], ['.render-123', 'slide.png'], ['/private.png'], ['a/b.png'], ['a\\b.png'], ['%2e%2e', 'private.png'], ['%252e%252e', 'private.png'], ['%2fprivate.png'], ['a\0.png'], ['a\r\n.png'], ['secret.html'], ['file.svg'], ['.env'], ['folder.png'], Array(9).fill('x')]) {
      const response = await serveGeneratedMedia(req('/cards/test.png'), 'cards', parts, root);
      assert.equal(response.status, 404, JSON.stringify(parts)); assert.equal(await response.text(), '');
    }
    assert.equal((await serveGeneratedMedia(req('/cards/test.png'), 'cards', null, root)).status, 404);
    assert.equal((await serveGeneratedMedia(req('/cards/test.png'), '../data' as GeneratedMediaKind, ['test.png'], root)).status, 404);
    assert.equal((await serveGeneratedMedia(req('/cards/test.png', { method: 'POST' }), 'cards', ['test.png'], root)).status, 405);
  });
});

test('reject symlinks for final files, intermediate directories, media roots and public itself', async () => {
  await fixture(async root => {
    const outside = path.join(root, 'private'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'private.png'), 'private-not-public');
    await fs.symlink(path.join(outside, 'private.png'), path.join(root, 'public/cards/link.png'));
    await fs.symlink(outside, path.join(root, 'public/cards/linked-folder'));
    for (const parts of [['link.png'], ['linked-folder', 'private.png']]) {
      assert.equal((await serveGeneratedMedia(req('/cards/link.png'), 'cards', parts, root)).status, 404);
    }
    await fs.rm(path.join(root, 'public/cards'), { recursive: true }); await fs.symlink(outside, path.join(root, 'public/cards'));
    assert.equal((await serveGeneratedMedia(req('/cards/private.png'), 'cards', ['private.png'], root)).status, 404);
    await fs.rm(path.join(root, 'public'), { recursive: true }); await fs.symlink(root, path.join(root, 'public'));
    await fs.mkdir(path.join(root, 'cards')); await fs.writeFile(path.join(root, 'cards/private.png'), 'private');
    assert.equal((await serveGeneratedMedia(req('/cards/private.png'), 'cards', ['private.png'], root)).status, 404);
  });
});

test('empty files and cancelled streams release resources and never expose a filesystem error', async () => {
  await fixture(async root => {
    await fs.writeFile(path.join(root, 'public/cards/empty.png'), '');
    const empty = await serveGeneratedMedia(req('/cards/empty.png'), 'cards', ['empty.png'], root);
    assert.equal(empty.status, 200); assert.equal(empty.headers.get('content-length'), '0'); assert.equal(await empty.text(), '');
    await fs.writeFile(path.join(root, 'public/videos/movie.mp4'), Buffer.alloc(2 * 1024 * 1024, 1));
    const controller = new AbortController();
    const response = await serveGeneratedMedia(req('/videos/movie.mp4', { signal: controller.signal }), 'videos', ['movie.mp4'], root);
    controller.abort();
    await assert.rejects(() => response.arrayBuffer());
    assert.equal((await serveGeneratedMedia(req('/videos/movie.mp4', { signal: controller.signal }), 'videos', ['movie.mp4'], root)).status, 499);
    const consumerCancelled = await serveGeneratedMedia(req('/videos/movie.mp4'), 'videos', ['movie.mp4'], root);
    await consumerCancelled.body!.cancel();
    assert.equal((await serveGeneratedMedia(req('/videos/movie.mp4', { method: 'HEAD' }), 'videos', ['movie.mp4'], root)).status, 200);
  });
});

test('a parent-directory swap cannot replace the verified file or public root while opening', async () => {
  // Deterministic filesystem interleavings, not timing-dependent symlink attacks.
  const source = await fs.readFile(new URL('../lib/generated-media.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  for (const race of ['opened-other-file', 'post-check-other-file', 'public-root-escape'] as const) {
    let fileChecks = 0, closed = 0, streams = 0;
    const info = (file: boolean, ino: number) => ({ dev: 1, ino, size: 6, mtime: new Date(0), isSymbolicLink: () => false, isFile: () => file, isDirectory: () => !file });
    const fakeFs = {
      async lstat(file: string) {
        if (file.endsWith('x.mp4')) { fileChecks++; return info(true, race === 'post-check-other-file' && fileChecks > 1 ? 20 : 10); }
        return info(false, 1);
      },
      async realpath(file: string) { return race === 'public-root-escape' && file === '/app/public' ? '/private/public' : file; },
      async open() { return {
        async stat() { return info(true, race === 'opened-other-file' ? 20 : 10); },
        async close() { closed++; },
        createReadStream() { streams++; return Readable.from([Buffer.from('SECRET')]); },
      }; },
    };
    const sandboxModule = { exports: {} as { serveGeneratedMedia: typeof serveGeneratedMedia } };
    vm.runInNewContext(compiled, {
      module: sandboxModule, exports: sandboxModule.exports, Request, Response, Headers, ReadableStream, process,
      require(name: string) {
        if (name === 'node:path') return path;
        if (name === 'node:fs') return { constants };
        if (name === 'node:fs/promises') return fakeFs;
        if (name === 'node:stream') return { Readable };
        throw new Error('Unexpected import');
      },
    });
    const response = await sandboxModule.exports.serveGeneratedMedia(req('/videos/x.mp4'), 'videos', ['x.mp4'], '/app');
    assert.equal(response.status, 404, race); assert.equal(await response.text(), ''); assert.equal(streams, 0);
    assert.equal(closed, race === 'public-root-escape' ? 0 : 1);
  }
});
