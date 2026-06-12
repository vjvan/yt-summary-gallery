/**
 * 共用 Whisper 轉錄 helper,集中處理三件事:
 *
 * 1. 原生 fetch 上傳(非阻塞),取代各檔案自己拼 execSync curl
 * 2. 超過 25MB 自動壓縮(48kbps mono 16kHz)
 * 3. 壓縮後仍超限 → ffmpeg 切段分別轉錄,時間軸自動平移合併
 *    (舊版 64kbps 壓縮只夠 ~52 分鐘音訊,更長直接炸 API)
 *
 * 語言不再強制 zh:不給 language 就讓 Whisper 自動偵測,
 * 英文影片才不會被硬轉成中文逐字稿。中文口播場景(remix/clean)自行傳 "zh"。
 */

import fs from "fs";
import path from "path";
import { run } from "./run-command";
import type { TranscriptSegment } from "./fetch-transcript";

const WHISPER_LIMIT_BYTES = 25 * 1024 * 1024;
// 20 分鐘 @48kbps ≈ 7MB,離 25MB 上限有充分餘裕
const CHUNK_SECONDS = 1200;

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface TranscribeResult {
  text: string;
  segments: TranscriptSegment[];
  /** 只在 wordTimestamps: true 時有內容 */
  words: WordTimestamp[];
}

export interface TranscribeOptions {
  /** 壓縮 / 切段中間檔存放目錄 */
  tmpDir: string;
  /** 不給就讓 Whisper 自動偵測語言 */
  language?: string;
  /** 需要 word-level 時間戳時開啟(remix / clean 用) */
  wordTimestamps?: boolean;
}

export async function probeDuration(filePath: string): Promise<number> {
  try {
    const out = await run(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { timeoutMs: 15000 }
    );
    return parseFloat(out.trim()) || 0;
  } catch {
    return 0;
  }
}

interface WhisperVerboseJson {
  text?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

async function whisperRequest(
  filePath: string,
  options: Pick<TranscribeOptions, "language" | "wordTimestamps">
): Promise<WhisperVerboseJson> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const form = new FormData();
  form.append(
    "file",
    new Blob([fs.readFileSync(filePath)]),
    path.basename(filePath)
  );
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  if (options.language) form.append("language", options.language);
  if (options.wordTimestamps) {
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
  }

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Whisper API error ${resp.status}: ${err.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * 轉錄一個音訊檔。自動處理壓縮與切段,回傳合併後的完整時間軸。
 */
export async function transcribeAudio(
  audioPath: string,
  options: TranscribeOptions
): Promise<TranscribeResult> {
  // 1. 超限先壓縮
  let finalAudio = audioPath;
  if (fs.statSync(audioPath).size > WHISPER_LIMIT_BYTES) {
    const compressed = path.join(options.tmpDir, "whisper-compressed.mp3");
    await run(
      `ffmpeg -i "${audioPath}" -vn -ac 1 -ar 16000 -b:a 48k -y "${compressed}"`,
      { timeoutMs: 600000 }
    );
    finalAudio = compressed;
  }

  // 2. 壓縮後仍超限 → 切段(-c copy 不重編碼,秒切)
  let chunkPaths: string[];
  if (fs.statSync(finalAudio).size > WHISPER_LIMIT_BYTES) {
    const chunkDir = path.join(options.tmpDir, "whisper-chunks");
    fs.mkdirSync(chunkDir, { recursive: true });
    await run(
      `ffmpeg -i "${finalAudio}" -f segment -segment_time ${CHUNK_SECONDS} -c copy -y "${chunkDir}/chunk-%03d.mp3"`,
      { timeoutMs: 600000 }
    );
    chunkPaths = fs
      .readdirSync(chunkDir)
      .filter((f) => f.startsWith("chunk-") && f.endsWith(".mp3"))
      .sort()
      .map((f) => path.join(chunkDir, f));
    if (chunkPaths.length === 0) throw new Error("ffmpeg 切段失敗:無 chunk 產出");
  } else {
    chunkPaths = [finalAudio];
  }

  // 3. 逐段轉錄,時間軸平移合併
  const segments: TranscriptSegment[] = [];
  const words: WordTimestamp[] = [];
  const texts: string[] = [];
  let offset = 0;

  for (const chunk of chunkPaths) {
    const data = await whisperRequest(chunk, options);
    for (const s of data.segments || []) {
      segments.push({ start: s.start + offset, end: s.end + offset, text: s.text.trim() });
    }
    for (const w of data.words || []) {
      words.push({ word: w.word.trim(), start: w.start + offset, end: w.end + offset });
    }
    if (data.text) texts.push(data.text);
    if (chunkPaths.length > 1) offset += await probeDuration(chunk);
  }

  return {
    text: texts.join(" ").trim() || segments.map((s) => s.text).join(" "),
    segments,
    words,
  };
}
