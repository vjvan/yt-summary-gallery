// Local inference only. Does not download models, change .env, or call cloud APIs.
import { spawn } from 'node:child_process';
import { access, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelRoot = path.resolve(process.env.WATCH_LOCAL_MODELS_DIR || path.join(homedir(), 'Documents/Codex/local-models'));
const model = process.env.WATCH_LOCAL_MODEL || 'qwen2.5:7b';
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}(?::[a-zA-Z0-9][a-zA-Z0-9._-]{0,39})?$/.test(model) || /cloud/i.test(model)) throw Error('僅允許本機模型名稱，不可指定雲端模型或網址。');
const whisperModel = process.env.WATCH_LOCAL_WHISPER_MODEL || path.join(modelRoot, 'whisper/ggml-small.bin');
const whisperBin = process.env.WATCH_LOCAL_WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
const ollamaBin = process.env.WATCH_LOCAL_OLLAMA_BIN || path.join(modelRoot, 'runtime/ollama-0.33.3/ollama');
if ([whisperModel, whisperBin, ollamaBin].some((value) => !path.isAbsolute(value))) throw Error('本機模型與執行檔設定必須使用絕對路徑。');
const portArg = process.argv.indexOf('--port');
const port = portArg < 0 ? 3000 : Number(process.argv[portArg + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('連接埠必須介於 1024–65535。');
const checkOnly = process.argv.includes('--check');
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 4000).unref();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
async function installedModels() {
  const response = await fetch('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw Error('本機 Ollama 未就緒。');
  const result = await response.json();
  if (!Array.isArray(result.models)) throw Error('11434 並非預期的 Ollama 服務；未停止或覆寫該程序。');
  return result.models.map((entry) => entry.name);
}
function own(child) {
  children.add(child);
  child.once('exit', (code) => { children.delete(child); if (!stopping) stop(code || 1); });
  child.once('error', () => { console.error('本機子程序啟動失敗，未改用雲端。'); stop(1); });
  return child;
}

try {
  await access(whisperModel, constants.R_OK);
  await access(whisperBin, constants.X_OK);
  let names;
  try { names = await installedModels(); }
  catch (error) {
    if (checkOnly) throw error;
    await access(ollamaBin, constants.X_OK);
    const runtimeHome = path.join(modelRoot, 'runtime-home');
    await mkdir(runtimeHome, { recursive: true });
    await mkdir(path.join(modelRoot, 'ollama'), { recursive: true });
    const log = await open(path.join(modelRoot, 'ollama-runtime.log'), 'a', 0o600);
    const runtime = own(spawn(ollamaBin, ['serve'], { cwd: path.dirname(ollamaBin), stdio: ['ignore', log.fd, log.fd], env: {
      PATH: process.env.PATH, HOME: runtimeHome, TMPDIR: process.env.TMPDIR,
      OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_MODELS: path.join(modelRoot, 'ollama'), OLLAMA_NO_CLOUD: '1',
    } }));
    await log.close();
    for (let attempt = 0; attempt < 30; attempt++) {
      if (stopping || runtime.exitCode !== null) throw Error('本機模型服務未能啟動；請檢查 ollama-runtime.log。');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try { names = await installedModels(); break; } catch { /* bounded startup wait */ }
    }
  }
  if (!names?.includes(model)) throw Error(`尚未安裝本機模型 ${model}。本指令不會自動下載或切換雲端。`);
  console.log(`觀看翻譯：全本機 ${model}；收音：本機 Whisper。未啟用付費 API fallback。`);
  console.log('本機總翻譯批數不限，每批最多 8 段；仍保留併發、逾時與停止機制。');
  if (checkOnly) console.log('模型檔案與 Ollama 已通過檢查；未執行推論。');
  else {
    console.log(`觀看頁：http://127.0.0.1:${port}/watch（請保持這個終端機開啟）`);
    const child = own(spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '--port', String(port)], {
      cwd: root, stdio: 'inherit', env: { ...process.env, WATCH_PROCESSING_MODE: 'local', WATCH_LOCAL_MODEL: model,
        WATCH_LOCAL_WHISPER_MODEL: whisperModel, WATCH_LOCAL_WHISPER_BIN: whisperBin },
    }));
    child.once('exit', (code) => { if (!stopping) stop(code || 0); });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '本機啟動失敗，沒有切換雲端。');
  stop(1);
}
