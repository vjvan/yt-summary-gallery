import { ensureSummaryShape, type Summary } from "./extract-summary";

export interface VideoScriptSegment {
  clip_index: number;
  start: number;
  end: number;
  subtitle: string;
}

export interface VideoScript {
  hook: string;
  segments: VideoScriptSegment[];
  cta: string;
}

export interface CombinedSummaryResult {
  summary: Summary;
  videoScript: VideoScript;
}

interface ClipData {
  sort_order: number;
  file_name: string;
  duration: number;
  duration_display: string;
  transcript: string;
  segments: string; // JSON string
}

const SYSTEM_PROMPT = `你是短影音內容策劃專家。以下是使用者拍攝的多段短影片逐字稿。
請分析所有片段,找出跨片段的共同主題和關鍵洞察,整合成一個完整的內容摘要。
同時,你需要從這些片段中挑選最精華的段落,組成一支 30-90 秒的短影音腳本。

輸出必須是嚴格的 JSON 格式:

{
  "title_display": "整合主題標題 (最多15個中文字,抓住所有片段的核心主題)",
  "one_liner": "一句話總結所有片段的核心主題 (20字以內)",
  "key_points": [
    {
      "label": "重點標籤 (2-4個字)",
      "content": "具體說明,整合多個片段的洞察 (20-40字)"
    }
  ],
  "key_quote": "所有片段中最有力或最有啟發性的一句話",
  "action_items": ["可執行的行動建議1", "行動建議2"],
  "tags": ["標籤1", "標籤2", "標籤3"],
  "highlights": [
    {
      "timestamp": 0,
      "label": "精華段落標題 (5-10字)",
      "description": "這段在講什麼 (15-30字)"
    }
  ],
  "short_video_script": {
    "hook": "開場金句,用來吸引觀眾停下來看 (10-20字,直接有力)",
    "segments": [
      {
        "clip_index": 1,
        "start": 5.0,
        "end": 12.5,
        "subtitle": "這段要顯示的字幕文字 (精簡版,15字以內)"
      }
    ],
    "cta": "結尾行動呼籲 (10-15字)"
  }
}

規則:
- 所有內容必須是繁體中文
- key_points 提供 3 到 5 個重點,要整合跨片段的洞察,不要逐片段列舉
- key_quote 選所有片段中最有啟發性的一句話,如果原文是英文要翻譯成中文
- action_items 提供 1 到 3 個觀眾看完可以立刻做的事
- tags 提供 3 到 5 個分類標籤
- highlights 從各片段中挑出 5 到 8 個精華時刻,timestamp 設為 0 即可
- 逐字稿可能有錯字或語音辨識錯誤,請根據上下文修正理解
- 不要使用表情符號
- 重點是整合和提煉,不是逐片段翻譯

short_video_script 規則:
- clip_index 是片段編號 (從 1 開始),對應逐字稿中「片段 N」的編號
- start 和 end 是該片段內的秒數,必須從逐字稿的時間戳精確對應
- 挑選 5 到 12 個精華段落,每段 10-30 秒,盡量長一些讓觀眾聽完整句話
- 總長度控制在 60-180 秒之間,要有足夠內容讓觀眾學到東西
- 盡量覆蓋每個片段的重點內容,不要只集中在開頭
- segments 按照最佳敘事順序排列,先建立背景,再展開重點,最後結論
- subtitle 是精簡過的字幕,不是逐字稿原文,要簡短有力
- hook 要能在前 3 秒抓住注意力
- cta 要引導觀眾採取行動 (關注/分享/留言)`;

/**
 * Build combined transcript text from all clips with markers.
 */
function buildCombinedTranscript(clips: ClipData[]): string {
  return clips
    .map((clip) => {
      let segmentText: string;
      try {
        const segments = JSON.parse(clip.segments) as Array<{
          start: number;
          end: number;
          text: string;
        }>;
        segmentText = segments
          .map((s) => {
            const m = Math.floor(s.start / 60);
            const sec = Math.floor(s.start % 60);
            return `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}`;
          })
          .join("\n");
      } catch {
        segmentText = clip.transcript;
      }

      return `=== 片段 ${clip.sort_order + 1}: ${clip.file_name} (${clip.duration_display}) ===\n${segmentText}`;
    })
    .join("\n\n");
}

/**
 * Extract a combined summary from multiple clip transcripts using GPT-4o-mini.
 */
export async function extractCombinedSummary(
  clips: ClipData[],
  projectTitle: string
): Promise<CombinedSummaryResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  let combinedText = buildCombinedTranscript(clips);

  // Truncate if too long
  if (combinedText.length > 100000) {
    combinedText =
      combinedText.slice(0, 48000) +
      "\n\n[...中間省略...]\n\n" +
      combinedText.slice(-48000);
  }

  const userMsg = `專案標題: ${projectTitle}\n片段數量: ${clips.length}\n\n${combinedText}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 3000,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenAI");

  const parsed = JSON.parse(content);

  const summary: Summary = ensureSummaryShape({
    title_display: parsed.title_display,
    one_liner: parsed.one_liner,
    key_points: parsed.key_points || [],
    key_quote: parsed.key_quote || "",
    action_items: parsed.action_items || [],
    tags: parsed.tags || [],
    highlights: parsed.highlights || [],
  });

  const videoScript: VideoScript = parsed.short_video_script || {
    hook: summary.one_liner,
    segments: [],
    cta: "Follow for more",
  };

  return { summary, videoScript };
}

export { buildCombinedTranscript };
