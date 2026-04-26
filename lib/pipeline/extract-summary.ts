const SYSTEM_PROMPT = `你是一個影片內容分析專家。根據以下附帶時間戳的影片逐字稿，產出結構化的繁體中文摘要。

輸出必須是嚴格的 JSON 格式:

{
  "title_display": "精簡的卡片標題 (最多15個中文字，抓住核心主題)",
  "one_liner": "一句話總結這部影片在講什麼 (20字以內)",
  "key_points": [
    {
      "label": "重點標籤 (2-4個字)",
      "content": "具體說明 (20-40字)"
    }
  ],
  "key_quote": "影片中最有力或最有啟發性的一句話",
  "action_items": ["可執行的行動建議1", "行動建議2"],
  "tags": ["標籤1", "標籤2", "標籤3"],
  "highlights": [
    {
      "timestamp": 125,
      "label": "精華段落標題 (5-10字)",
      "description": "這段在講什麼 (15-30字)"
    }
  ]
}

規則:
- 所有內容必須是繁體中文
- key_points 提供 3 到 5 個重點，content 要具體，不要泛泛而談
- key_quote 選最有啟發性或爭議性的那句，如果原文是英文要翻譯成中文
- action_items 提供 1 到 3 個觀眾看完可以立刻做的事
- tags 提供 3 到 5 個分類標籤
- highlights 提供 5 到 8 個精華片段，timestamp 是該段落開始的秒數 (整數)，從逐字稿的時間戳判斷
- highlights 按時間順序排列，涵蓋影片從頭到尾的重要段落
- 逐字稿可能有錯字或語音辨識錯誤，請根據上下文修正理解
- 不要使用表情符號`;

export interface Highlight {
  timestamp: number;
  label: string;
  description: string;
}

export interface Summary {
  title_display: string;
  one_liner: string;
  key_points: { label: string; content: string }[];
  key_quote: string;
  action_items: string[];
  tags: string[];
  highlights: Highlight[];
}

export async function extractSummary(
  transcriptWithTimestamps: string,
  videoTitle: string,
  channel: string
): Promise<Summary> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  let text = transcriptWithTimestamps;
  if (text.length > 100000) {
    text = text.slice(0, 48000) + "\n\n[...中間省略...]\n\n" + text.slice(-48000);
  }

  const userMsg = `影片標題: ${videoTitle}\n頻道: ${channel}\n\n逐字稿 (含時間戳):\n${text}`;

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

  const summary: Summary = JSON.parse(content);
  if (!summary.highlights) summary.highlights = [];

  return summary;
}
