/**
 * Auto-clean pipeline for short videos (two-phase).
 * Phase 1: analyzeVideo() - transcribe + detect fillers/silences → return editable items
 * Phase 2: assembleClean() - take user selections → assemble clean video + SRT
 */

import fs from "fs";
import path from "path";
import { run } from "./run-command";
import { transcribeAudio, probeDuration } from "./transcribe";
import { segmentsToSrt } from "./generate-srt";

const VIDEO_EXTS = ["mp4", "mov", "webm", "avi", "mkv"];

const FILLER_PATTERNS = [
  /^[嗯啊哦呃欸唔嘿哈吧呢喔嘛齁蛤]+$/,
  /^(那個|就是|然後|對對對|好的|OK|ok|嗯嗯|啊啊|呃呃|是是是|對對|好好好|對啊|好啊|那|就)+$/,
];

const FILLER_WORDS = new Set([
  "嗯", "啊", "哦", "呃", "欸", "唔", "那個", "就是", "然後", "對",
  "那", "就", "好", "吧", "呢", "喔", "嘛", "齁", "蛤",
]);

// Minimum silence gap to detect (seconds)
const SILENCE_THRESHOLD = 0.4;

/** An item in the editor timeline */
export interface TimelineItem {
  id: number;
  type: "phrase" | "silence" | "filler";
  text: string;
  start: number;
  end: number;
  duration: number;
  selected: boolean; // true = marked for removal
  reason?: string;
}

export interface AnalysisResult {
  items: TimelineItem[];
  originalDuration: number;
  estimatedCleanDuration: number;
  videoPath: string; // original uploaded file (for preview)
}

export interface AssembleResult {
  videoPath: string;
  srtPath: string;
  srtContent: string;
  originalDuration: number;
  cleanDuration: number;
  removedCount: number;
}

// ===== Shared utilities =====

async function extractAudio(videoPath: string, outputDir: string): Promise<string> {
  const audioPath = path.join(outputDir, "audio.mp3");
  await run(
    `ffmpeg -i "${videoPath}" -vn -b:a 128k -y "${audioPath}"`,
    { timeoutMs: 300000 }
  );
  return audioPath;
}

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

function isPureFiller(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return FILLER_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Group words into natural phrases (2-6 words, split on pauses > 0.15s).
 * Also detect silence gaps between phrases.
 */
function buildTimeline(words: WhisperWord[], totalDuration: number): TimelineItem[] {
  if (words.length === 0) return [];

  const items: TimelineItem[] = [];
  let id = 0;

  // Build phrases by grouping words with small gaps
  let phraseWords: WhisperWord[] = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;

    // Split phrase on gaps > 0.15s or if phrase already has 6+ words
    if (gap > 0.15 || phraseWords.length >= 6) {
      // Emit current phrase
      const phraseText = phraseWords.map((w) => w.word).join("");
      const phraseStart = phraseWords[0].start;
      const phraseEnd = phraseWords[phraseWords.length - 1].end;
      const isFiller = isPureFiller(phraseText) || (phraseWords.length === 1 && FILLER_WORDS.has(phraseWords[0].word));

      items.push({
        id: id++,
        type: isFiller ? "filler" : "phrase",
        text: phraseText,
        start: phraseStart,
        end: phraseEnd,
        duration: Math.round((phraseEnd - phraseStart) * 100) / 100,
        selected: isFiller,
        reason: isFiller ? "語助詞" : undefined,
      });

      // Check for silence gap before next phrase
      if (gap >= SILENCE_THRESHOLD) {
        items.push({
          id: id++,
          type: "silence",
          text: "",
          start: words[i - 1].end,
          end: words[i].start,
          duration: Math.round(gap * 100) / 100,
          selected: true,
          reason: "無聲",
        });
      }

      phraseWords = [words[i]];
    } else {
      phraseWords.push(words[i]);
    }
  }

  // Emit last phrase
  if (phraseWords.length > 0) {
    const phraseText = phraseWords.map((w) => w.word).join("");
    const phraseStart = phraseWords[0].start;
    const phraseEnd = phraseWords[phraseWords.length - 1].end;
    const isFiller = isPureFiller(phraseText) || (phraseWords.length === 1 && FILLER_WORDS.has(phraseWords[0].word));

    items.push({
      id: id++,
      type: isFiller ? "filler" : "phrase",
      text: phraseText,
      start: phraseStart,
      end: phraseEnd,
      duration: Math.round((phraseEnd - phraseStart) * 100) / 100,
      selected: isFiller,
      reason: isFiller ? "語助詞" : undefined,
    });
  }

  // Check for trailing silence
  const lastItem = items[items.length - 1];
  if (lastItem && totalDuration - lastItem.end >= SILENCE_THRESHOLD) {
    items.push({
      id: id++,
      type: "silence",
      text: "",
      start: lastItem.end,
      end: totalDuration,
      duration: Math.round((totalDuration - lastItem.end) * 100) / 100,
      selected: true,
      reason: "無聲",
    });
  }

  // Check for leading silence
  if (items.length > 0 && items[0].start >= SILENCE_THRESHOLD) {
    items.unshift({
      id: id++,
      type: "silence",
      text: "",
      start: 0,
      end: items[0].start,
      duration: Math.round(items[0].start * 100) / 100,
      selected: true,
      reason: "無聲",
    });
  }

  return items;
}

/**
 * Use GPT to refine decisions (detect duplicates, stutters, etc).
 */
async function gptRefine(
  items: TimelineItem[]
): Promise<Map<number, { action: "CUT"; reason: string }>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return new Map();

  const phrases = items.filter((i) => i.type === "phrase" && !i.selected);
  if (phrases.length === 0) return new Map();

  const prompt = `你是短影音贅字清除助手。以下是一支影片的逐字稿片段（已過濾明顯語助詞）。

找出應該額外刪除的片段:
- 完全重複的句子 (前面說過一樣的話)
- 口誤後重新說的前一句 (只保留修正後的版本)
- 無意義的斷句碎片 (單獨一個字不成句)

不要刪除有實質內容的片段。輸出 JSON:
{ "cuts": [{ "id": 數字, "reason": "原因" }] }

不要使用表情符號。`;

  const data = phrases.map((p) => ({ id: p.id, text: p.text }));

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: JSON.stringify(data) },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!resp.ok) return new Map();

    const result = await resp.json();
    const content = result.choices[0]?.message?.content;
    if (!content) return new Map();

    const parsed = JSON.parse(content);
    const cuts = new Map<number, { action: "CUT"; reason: string }>();
    for (const c of parsed.cuts || []) {
      cuts.set(c.id, { action: "CUT", reason: c.reason });
    }
    return cuts;
  } catch {
    return new Map();
  }
}

// ===== Phase 1: Analyze =====

export async function analyzeVideo(
  videoPath: string,
  workDir: string,
  onProgress?: (step: string, detail: string) => void
): Promise<AnalysisResult> {
  fs.mkdirSync(workDir, { recursive: true });

  const ext = path.extname(videoPath).slice(1).toLowerCase();
  const isVideo = VIDEO_EXTS.includes(ext);
  const originalDuration = await probeDuration(videoPath);

  // Extract audio
  onProgress?.("extracting", "提取音訊中...");
  let audioPath: string;
  if (isVideo) {
    audioPath = await extractAudio(videoPath, workDir);
  } else {
    audioPath = videoPath;
  }

  // Transcribe at word level(壓縮 / 25MB 切段在 transcribeAudio 內處理)
  // 口播清理是允雷自己的中文錄影,保留 language=zh
  onProgress?.("transcribing", "辨識語音中...");
  const { words }: { words: WhisperWord[] } = await transcribeAudio(audioPath, {
    tmpDir: workDir,
    language: "zh",
    wordTimestamps: true,
  });

  if (words.length === 0) {
    throw new Error("影片中未偵測到語音");
  }

  // Build timeline with phrases + silences
  onProgress?.("analyzing", "分析贅字與重複片段...");
  const items = buildTimeline(words, originalDuration);

  // GPT refinement (detect duplicates, stutters)
  const gptCuts = await gptRefine(items);
  for (const [itemId, decision] of gptCuts) {
    const item = items.find((i) => i.id === itemId);
    if (item) {
      item.selected = true;
      item.reason = decision.reason;
    }
  }

  // Re-assign sequential IDs after all modifications
  items.forEach((item, idx) => { item.id = idx; });

  // Calculate estimated clean duration
  const estimatedCleanDuration = items
    .filter((i) => !i.selected)
    .reduce((sum, i) => sum + i.duration, 0);

  // Cleanup audio temp files
  for (const temp of ["audio.mp3", "whisper-compressed.mp3"]) {
    const p = path.join(workDir, temp);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.rmSync(path.join(workDir, "whisper-chunks"), { recursive: true, force: true });

  return {
    items,
    originalDuration,
    estimatedCleanDuration: Math.round(estimatedCleanDuration * 10) / 10,
    videoPath,
  };
}

// ===== Phase 2: Assemble =====

export async function assembleClean(
  videoPath: string,
  keepItems: Array<{ start: number; end: number; text: string }>,
  outputDir: string
): Promise<AssembleResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const workDir = path.join(outputDir, "work");
  fs.mkdirSync(workDir, { recursive: true });

  const ext = path.extname(videoPath).slice(1).toLowerCase();
  const isVideo = VIDEO_EXTS.includes(ext);
  const originalDuration = await probeDuration(videoPath);

  const partFiles: string[] = [];
  const srtSegments: Array<{ start: number; end: number; text: string }> = [];
  let currentTime = 0;

  for (let i = 0; i < keepItems.length; i++) {
    const item = keepItems[i];
    const duration = item.end - item.start;
    if (duration < 0.1) continue;

    const partPath = path.join(workDir, `part-${i}.mp4`);

    if (isVideo) {
      await run(
        `ffmpeg -ss ${item.start} -accurate_seek -i "${videoPath}" -t ${duration} ` +
          `-c:v libx264 -c:a aac -b:a 128k -ar 44100 -pix_fmt yuv420p ` +
          `-vf "fps=30" -y "${partPath}"`,
        { timeoutMs: 120000 }
      );
    } else {
      await run(
        `ffmpeg -f lavfi -i "color=c=#1a1a1a:s=1080x1920:d=${duration}:r=30" ` +
          `-ss ${item.start} -i "${videoPath}" -t ${duration} ` +
          `-c:v libx264 -c:a aac -b:a 128k -ar 44100 -pix_fmt yuv420p ` +
          `-shortest -y "${partPath}"`,
        { timeoutMs: 120000 }
      );
    }

    partFiles.push(partPath);
    srtSegments.push({
      start: currentTime,
      end: currentTime + duration,
      text: item.text,
    });
    currentTime += duration;
  }

  if (partFiles.length === 0) {
    throw new Error("沒有可保留的片段");
  }

  // Concat
  const concatList = path.join(workDir, "concat.txt");
  fs.writeFileSync(concatList, partFiles.map((p) => `file '${p}'`).join("\n"));

  const outputPath = path.join(outputDir, "clean.mp4");
  await run(
    `ffmpeg -f concat -safe 0 -i "${concatList}" ` +
      `-c:v libx264 -c:a aac -b:a 128k -ar 44100 -pix_fmt yuv420p ` +
      `-movflags +faststart -y "${outputPath}"`,
    { timeoutMs: 300000 }
  );

  // SRT
  const srtContent = segmentsToSrt(srtSegments);
  const srtPath = path.join(outputDir, "clean.srt");
  fs.writeFileSync(srtPath, srtContent, "utf-8");

  // Cleanup
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

  return {
    videoPath: outputPath,
    srtPath,
    srtContent,
    originalDuration,
    cleanDuration: Math.round(currentTime * 10) / 10,
    removedCount: 0, // caller can compute this
  };
}
