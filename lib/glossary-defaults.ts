/**
 * Glossary 預設值(系統初次啟動時 seed 進 settings 表)
 *
 * 這份預設是 P2P AI Lab 領域:AI 影片創作 + 設計系統 + Web 開發
 * 使用者可從 /glossary 頁面自行編輯,編輯後寫進 settings 表覆蓋本檔。
 */

export interface Glossary {
  no_translate_terms: string[];
  term_map: Array<[string, string]>;
  style_rules: string[];
}

export const DEFAULT_NO_TRANSLATE_TERMS: string[] = [
  // AI 影片生成平台
  "fal.ai", "Weavy.ai", "Remotion", "Renoise",
  "Sora", "Veo", "Veo 3", "Runway", "Pika", "Kling",
  "Hailuo", "Hunyuan", "Luma", "Dream Machine",

  // AI 影像生成
  "Midjourney", "Flux", "SDXL", "Imagen", "DALL-E", "DALL·E",
  "Nano Banana", "nano-banana",

  // ComfyUI 生態
  "ComfyUI", "InvokeAI", "Forge", "Auto1111", "A1111",

  // 音訊
  "ElevenLabs", "Suno", "Udio", "Whisper",

  // LLM
  "Claude", "GPT", "GPT-4o", "GPT-5", "Gemini", "DeepSeek", "Sonnet", "Opus", "Haiku",

  // 設計工具
  "Figma", "FigJam", "Stitch", "Aura", "Framer", "Spline",

  // 開發
  "GitHub", "VSCode", "Cursor", "Claude Code", "Codex",
  "Next.js", "React", "Vue", "Svelte", "Tailwind",
  "Vercel", "Cloudflare", "Supabase", "n8n",
  "TypeScript", "JavaScript", "Python",

  // 影片術語
  "B-roll", "A-roll", "MVP", "landing page", "Hero",
  "DESIGN.md", "design.md",
];

export const DEFAULT_TERM_MAP: Array<[string, string]> = [
  // AI 影片創作
  ["iterate", "迭代"],
  ["iteration", "迭代"],
  ["remix", "重混"],
  ["regenerate", "重新生成"],
  ["refine", "細修"],
  ["workflow", "工作流"],
  ["pipeline", "流程"],
  ["node-based", "節點式"],
  ["reference image", "參考圖"],
  ["character consistency", "角色一致性"],
  ["aspect ratio", "比例"],
  ["frame rate", "影格率"],
  ["upscale", "升解析度"],
  ["render", "渲染"],
  ["hook", "開場鉤子"],
  ["jumpcut", "跳剪"],
  ["transition", "轉場"],
  ["voiceover", "旁白"],
  ["thumbnail", "縮圖"],
  ["one-shot", "一次到位"],
  ["fine-tune", "微調"],
  ["lip sync", "對嘴"],
  ["motion design", "動態設計"],
  ["storyboard", "分鏡"],

  // 設計系統
  ["design system", "設計系統"],
  ["design token", "設計 token"],
  ["component", "元件"],
  ["spec", "規格"],
  ["specification", "規格"],
  ["mockup", "原型圖"],
  ["wireframe", "線框稿"],

  // 工程
  ["deploy", "部署"],
  ["deployment", "部署"],
  ["repo", "倉庫"],
  ["repository", "倉庫"],
  ["commit", "commit"],
  ["pull request", "PR"],
  ["build", "建置"],
  ["debug", "除錯"],
  ["refactor", "重構"],
  ["open source", "開源"],
  ["opensource", "開源"],
];

export const DEFAULT_STYLE_RULES: string[] = [
  "口語填充詞(you know, actually, like, basically, I mean, sort of)多數情況省略不譯,讓中文聽起來自然。",
  "「kind of / sort of」翻成「有點」或「算是」,不要逐字直譯成「種類」「有點查看」這種錯誤。",
  "「let's say / for example」翻成「比方說」或「舉例來說」。",
  "句尾的 right?, you know?, OK? 這種反問詞,通常省略不譯。",
  "「a big deal」依語境翻成「重要的事」、「值得注意的事」,不要直譯「大事件」。",
  "「play around with」翻成「玩玩看」、「試試看」、「實驗看看」。",
  "句子過於口語破碎時,允許合理重組讓中文通順,但不可改變原意。",
];

export const DEFAULT_GLOSSARY: Glossary = {
  no_translate_terms: DEFAULT_NO_TRANSLATE_TERMS,
  term_map: DEFAULT_TERM_MAP,
  style_rules: DEFAULT_STYLE_RULES,
};
