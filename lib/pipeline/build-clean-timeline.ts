import type { EnrichedSegment } from "./transcribe-clips";

export interface SubtitlePhrase {
  text: string;
  start: number; // relative to segment start
  end: number;   // relative to segment start
}

export interface CleanSegment {
  clip_index: number;
  start: number;
  end: number;
  subtitle: string;
  original_text: string;
  phrases?: SubtitlePhrase[]; // word-level subtitle phrases
}

export interface SubtitleCue {
  text: string;
  video_start: number; // absolute time in final video
  video_end: number;
}

export interface CleanTimeline {
  hook: string;
  segments: CleanSegment[];
  cta: string;
  total_duration: number;
  subtitle_cues?: SubtitleCue[]; // populated after assembly
}

interface ClipData {
  sort_order: number;
  file_name: string;
  duration: number;
  transcript: string;
  segments: string; // JSON string
}

interface TaggedSegment {
  clip_index: number;
  seg_index: number;
  start: number;
  end: number;
  text: string;
  words?: Array<{ word: string; start: number; end: number }>;
}

// Filler word patterns (pure filler segments)
const FILLER_PATTERNS = [
  /^[嗯啊哦呃欸唔嘿哈吧呢喔嘛齁蛤]+$/,
  /^(那個|就是|然後|對對對|好的|OK|ok|嗯嗯|啊啊|呃呃|是是是|對對|好好好)+$/,
  /^\.{2,}$/,
  /^\s*$/,
];

// Leading filler words to trim via word-level timestamps
const LEADING_FILLERS = new Set([
  "嗯", "啊", "哦", "呃", "欸", "唔", "那個", "就是", "然後", "對",
]);

const SYSTEM_PROMPT = `你是短影音剪輯助手。你會收到 Whisper 語音辨識的逐字稿段落。
每個段落有 clip_index、seg_index、start、end、text。

你的任務:
1. 判斷每個段落是 KEEP (保留) 還是 CUT (剪掉)
2. 為保留的段落寫出精簡字幕
3. 安排最佳播放順序

CUT 標準 (只有以下情況才 CUT,其他一律 KEEP):
- 整段只有填充詞: 嗯、啊、哦、呃
- 完全重複的句子 (說了一模一樣的話)
- 超過 3 秒的純停頓

KEEP 標準 (盡量保留):
- 任何有實質內容的段落都要 KEEP
- 即使包含一些語氣詞,只要有實質內容就 KEEP
- 優先保留完整的句子和論述
- 目標是盡量多保留內容,只剪掉明顯的廢話

輸出 JSON:
{
  "hook": "開場金句 (10-20字)",
  "decisions": [
    {
      "clip_index": 0,
      "seg_index": 0,
      "action": "KEEP",
      "subtitle": "精簡字幕 (20字以內)",
      "priority": 1
    },
    {
      "clip_index": 0,
      "seg_index": 1,
      "action": "CUT",
      "reason": "填充詞"
    }
  ],
  "play_order": [0, 2, 5, 3],
  "cta": "結尾行動呼籲 (10-15字)"
}

規則:
- 所有字幕必須是繁體中文
- subtitle 要精簡、修正語病、去贅字,不是逐字稿原文
- priority 越小越重要 (1 = 最重要)
- play_order 是 decisions 中 KEEP 項目的索引,按最佳敘事順序排列
- 目標總長度: {{TARGET_MIN}}-{{TARGET_MAX}} 秒
- 不要使用表情符號`;

/**
 * Check if a segment is pure filler.
 */
function isPureFiller(text: string): boolean {
  const trimmed = text.trim();
  return FILLER_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Trim leading filler words using word-level timestamps.
 * Returns adjusted start time.
 */
function trimLeadingFillers(seg: TaggedSegment): number {
  if (!seg.words || seg.words.length === 0) return seg.start;

  let newStart = seg.start;
  for (const w of seg.words) {
    if (LEADING_FILLERS.has(w.word.trim())) {
      newStart = w.end + 0.05; // skip past the filler word
    } else {
      break;
    }
  }
  return Math.min(newStart, seg.end - 0.5); // ensure at least 0.5s remains
}

/**
 * Merge adjacent short Whisper segments into sentence-level blocks.
 * Whisper often splits speech into 1-2 second fragments. This merges
 * consecutive segments from the same clip if the gap is < 1.5 seconds,
 * producing blocks of 5-15 seconds that GPT can evaluate as units.
 */
function mergeAdjacentSegments(
  segments: Array<{ clip_index: number; start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> }>
): TaggedSegment[] {
  if (segments.length === 0) return [];

  const merged: TaggedSegment[] = [];
  let current = { ...segments[0], seg_index: 0 };

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const gap = seg.start - current.end;

    // Merge aggressively: same clip, gap < 3s, total < 30s
    // Produces longer, complete segments that sound natural
    if (
      seg.clip_index === current.clip_index &&
      gap < 3 &&
      seg.end - current.start < 30
    ) {
      current.end = seg.end;
      current.text = current.text + seg.text;
      if (current.words && seg.words) {
        current.words = [...current.words, ...seg.words];
      }
    } else {
      merged.push({ ...current, seg_index: merged.length });
      current = { ...seg, seg_index: 0 };
    }
  }
  merged.push({ ...current, seg_index: merged.length });

  return merged;
}

/**
 * Build a clean timeline by analyzing Whisper segments with GPT.
 */
export async function buildCleanTimeline(
  clips: ClipData[],
  projectTitle: string,
  target: { min: number; max: number } = { min: 45, max: 60 }
): Promise<CleanTimeline> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  // Build raw segment list (filter pure filler)
  const rawSegments: Array<{
    clip_index: number;
    start: number;
    end: number;
    text: string;
    words?: Array<{ word: string; start: number; end: number }>;
  }> = [];

  for (const clip of clips) {
    let parsed: EnrichedSegment[];
    try {
      parsed = JSON.parse(clip.segments);
    } catch {
      continue;
    }

    for (let i = 0; i < parsed.length; i++) {
      if (isPureFiller(parsed[i].text)) continue;
      rawSegments.push({
        clip_index: clip.sort_order,
        start: parsed[i].start,
        end: parsed[i].end,
        text: parsed[i].text,
        words: parsed[i].words,
      });
    }
  }

  // Merge adjacent short segments into sentence-level blocks
  const allSegments = mergeAdjacentSegments(rawSegments);

  if (allSegments.length === 0) {
    return { hook: projectTitle, segments: [], cta: "", total_duration: 0 };
  }

  // Send to GPT
  const prompt = SYSTEM_PROMPT
    .replace("{{TARGET_MIN}}", String(target.min))
    .replace("{{TARGET_MAX}}", String(target.max));

  const segmentsForGpt = allSegments.map((s) => ({
    clip_index: s.clip_index,
    seg_index: s.seg_index,
    start: Math.round(s.start * 10) / 10,
    end: Math.round(s.end * 10) / 10,
    text: s.text,
  }));

  const userMsg = `Project: ${projectTitle}\nTarget: ${target.min}-${target.max}s\n\nSegments:\n${JSON.stringify(segmentsForGpt)}`;

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
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 4000,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Empty GPT response");

  const result = JSON.parse(content) as {
    hook: string;
    decisions: Array<{
      clip_index: number;
      seg_index: number;
      action: string;
      subtitle?: string;
      priority?: number;
      reason?: string;
    }>;
    play_order: number[];
    cta: string;
  };

  // Build KEEP segments in play_order
  const keepDecisions = result.decisions.filter((d) => d.action === "KEEP");

  // Get segments in the order specified by play_order
  const orderedKeep = (result.play_order || [])
    .map((idx) => keepDecisions[idx])
    .filter(Boolean);

  // Fallback: if play_order is empty or invalid, use keepDecisions as-is
  const finalKeep = orderedKeep.length > 0 ? orderedKeep : keepDecisions;

  // Build clean segments with word-level trimming
  let totalDuration = 0;
  const cleanSegments: CleanSegment[] = [];

  for (const decision of finalKeep) {
    const original = allSegments.find(
      (s) =>
        s.clip_index === decision.clip_index &&
        s.seg_index === decision.seg_index
    );
    if (!original) continue;

    // Trim leading filler words
    const adjustedStart = trimLeadingFillers(original);
    const segDuration = original.end - adjustedStart;

    // Only enforce hard cap at 3x target max
    if (totalDuration + segDuration > target.max * 3) {
      continue;
    }

    // One subtitle per segment (complete sentence, no splitting)
    cleanSegments.push({
      clip_index: original.clip_index,
      start: Math.round(adjustedStart * 100) / 100,
      end: Math.round(original.end * 100) / 100,
      subtitle: original.text,
      original_text: original.text,
    });

    totalDuration += segDuration;
  }

  return {
    hook: result.hook || projectTitle,
    segments: cleanSegments,
    cta: result.cta || "",
    total_duration: Math.round(totalDuration * 10) / 10,
  };
}
