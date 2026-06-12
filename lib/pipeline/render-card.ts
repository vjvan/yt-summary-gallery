import fs from "fs";
import path from "path";
import type { Summary, ActionItem, Pitfall, Highlight, VideoGenre } from "./extract-summary";
import type { VideoMetadata } from "./fetch-transcript";

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "card.html");

/**
 * 配色主題系統。每張圖卡都吃這套 token,讓視覺多元化又不破壞既有 layout。
 *
 * 設計約束:
 *  - card-bg: 整張 1080x1350 卡的底色 (有的 theme 會用米色,不全是白)
 *  - accent: 主色, 對應原本 --orange
 *  - accent-light: 主色淡底 (chip / point bg / quote 漸變)
 *  - accent-dark: 主色重 (gradient / hover)
 *
 * 加新 theme 只要再新增一筆,並更新 pickTheme 預設權重。
 */
export interface CardTheme {
  id: string;
  label: string;
  cardBg: string;
  accent: string;
  accentLight: string;
  accentDark: string;
}

export const CARD_THEMES: Record<string, CardTheme> = {
  "wine-cream": {
    id: "wine-cream",
    label: "酒紅米色",
    cardBg: "#F2EBE3",
    accent: "#A86F71",
    accentLight: "#E8D5CD",
    accentDark: "#8B5755",
  },
  "orange-classic": {
    id: "orange-classic",
    label: "橘色經典",
    cardBg: "#FFFFFF",
    accent: "#E8722A",
    accentLight: "#FFF3EB",
    accentDark: "#C45D1E",
  },
  "forest-cream": {
    id: "forest-cream",
    label: "森綠米色",
    cardBg: "#F5F1E8",
    accent: "#4A6B5C",
    accentLight: "#E2EAE3",
    accentDark: "#344E42",
  },
  "navy-gold": {
    id: "navy-gold",
    label: "海軍金奶",
    cardBg: "#F8F5ED",
    accent: "#1F3247",
    accentLight: "#DCE4EC",
    accentDark: "#14202E",
  },
  "berry-cream": {
    id: "berry-cream",
    label: "莓紅奶油",
    cardBg: "#F5EFE8",
    accent: "#8E3A4A",
    accentLight: "#F2D9DD",
    accentDark: "#6B2B38",
  },
};

const DEFAULT_THEME_ID = "wine-cream";

/**
 * 沒指定 theme 時,用 video_id hash 對應到一個 theme,讓不同影片自動長不同樣
 * (達成 user 要的「不要這麼死板或單一」)。同一支影片每次重生都拿到同一個
 * theme,確保穩定性;若要強制換,從 API 帶 ?theme=xxx 即可。
 */
export function pickTheme(videoId: string, override?: string): CardTheme {
  if (override && CARD_THEMES[override]) return CARD_THEMES[override];
  if (!videoId) return CARD_THEMES[DEFAULT_THEME_ID];
  // FNV-1a hash 簡單版,夠分散
  let h = 2166136261;
  for (let i = 0; i < videoId.length; i++) {
    h ^= videoId.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  const ids = Object.keys(CARD_THEMES);
  return CARD_THEMES[ids[h % ids.length]];
}

function buildThemeCss(theme: CardTheme): string {
  return [
    `--accent: ${theme.accent};`,
    `--accent-light: ${theme.accentLight};`,
    `--accent-dark: ${theme.accentDark};`,
    `--card-bg: ${theme.cardBg};`,
  ].join("\n    ");
}

/**
 * Slide ID 對應到 card.html 的 data-slide-id。順序就是 carousel 顯示順序。
 *
 * cover -> 永遠第一張
 * tldr -> 60 秒看懂 (新, 段落式)
 * keypoints -> 重點解構 (原 P2 重點摘要)
 * timeline -> 時間軸 (新, 用 highlights)
 * actions -> 立即動手 (原 P4, 升級含 expected_outcome / time_estimate)
 * pitfalls -> 陷阱清單 (新)
 * quote -> 一句記住 (原 P3 KEY QUOTE)
 * mindmap -> 概念地圖 (原 P7 Mermaid)
 * recall -> 自我測驗 (新, toggle 預設關)
 */
export type SlideId =
  | "cover"
  | "tldr"
  | "keypoints"
  | "timeline"
  | "actions"
  | "pitfalls"
  | "quote"
  | "mindmap"
  | "recall";

/**
 * 依影片類型 (genre) 決定該渲染哪些卡。讓每張影片的 carousel 都有變化,不再死板的 7 卡通用。
 *
 * 設計考量:
 * - tutorial / review 類有「具體該做什麼」可講 -> 重 actions + pitfalls
 * - opinion / interview 類重金句跟概念地圖
 * - news 類資訊密度高 -> 重 TL;DR + timeline
 * - other 走通用全包 (不確定性高的 fallback)
 */
export function pickLayout(genre: VideoGenre, includeRecall: boolean): SlideId[] {
  const layouts: Record<VideoGenre, SlideId[]> = {
    tutorial: ["cover", "tldr", "keypoints", "timeline", "actions", "pitfalls", "mindmap"],
    opinion: ["cover", "tldr", "keypoints", "quote", "mindmap"],
    interview: ["cover", "tldr", "timeline", "keypoints", "quote"],
    news: ["cover", "tldr", "keypoints", "timeline"],
    review: ["cover", "tldr", "keypoints", "actions", "pitfalls", "quote"],
    other: ["cover", "tldr", "keypoints", "timeline", "actions", "pitfalls", "quote", "mindmap"],
  };
  const layout = layouts[genre] || layouts.other;
  if (includeRecall) layout.push("recall");
  return layout;
}

function buildKeyPointsHtml(points: Summary["key_points"]): string {
  return points
    .slice(0, 5)
    .map(
      (kp) => `<div class="point">
      <div class="point-label">${kp.label}</div>
      <div class="point-content">${kp.content}</div>
    </div>`
    )
    .join("\n");
}

/**
 * v2: action_items 是 ActionItem[] 結構 (action / expected_outcome / time_estimate)。
 * 舊資料反序列化後會被 ensureSummaryShape 補空字串,所以這裡可以放心讀。
 */
function buildActionItemsHtml(items: ActionItem[]): string {
  return items
    .slice(0, 3)
    .map((item) => {
      const meta: string[] = [];
      if (item.time_estimate) meta.push(`⏱ ${item.time_estimate}`);
      if (item.expected_outcome) meta.push(`→ ${item.expected_outcome}`);
      const metaHtml = meta.length
        ? `<div class="action-meta">${meta.join("　·　")}</div>`
        : "";
      return `<div class="action-item">
      <div class="checkbox"></div>
      <div class="action-body">
        <div class="action-text">${item.action}</div>
        ${metaHtml}
      </div>
    </div>`;
    })
    .join("\n");
}

function buildTimelineHtml(highlights: Highlight[]): string {
  // 強制按時間升序 (DB 內可能亂序),最多 8 個
  return [...highlights]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 8)
    .map((h) => {
      const time = formatTimestamp(h.timestamp);
      return `<div class="timeline-row">
      <div class="timeline-time">[${time}]</div>
      <div class="timeline-body">
        <div class="timeline-label">${h.label}</div>
        <div class="timeline-desc">${h.description}</div>
      </div>
    </div>`;
    })
    .join("\n    ");
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildPitfallsHtml(pitfalls: Pitfall[]): string {
  return pitfalls
    .slice(0, 3)
    .map(
      (p) => `<div class="pitfall">
      <div class="pitfall-icon">⚠ 注意</div>
      <div class="pitfall-warn">${p.warn}</div>
      <div class="pitfall-why">${p.why}</div>
    </div>`
    )
    .join("\n");
}

function buildRecallHtml(questions: string[]): string {
  return questions
    .slice(0, 3)
    .map(
      (q, i) => `<div class="recall-q">
      <div class="recall-q-num">${i + 1}</div>
      <div class="recall-q-text">${q}</div>
    </div>`
    )
    .join("\n");
}

function buildTagsHtml(tags: string[]): string {
  return tags
    .slice(0, 4)
    .map((t) => `<span class="meta-tag">${t}</span>`)
    .join("");
}

function buildTagsPillHtml(tags: string[]): string {
  return tags
    .slice(0, 5)
    .map((t) => `<span class="tag">${t}</span>`)
    .join("");
}

function escapeMermaidLabel(text: string, maxLen: number = 32): string {
  // Mermaid mindmap node text: 去 backtick / 換行 / 雙引號,並裁切到合理長度
  const cleaned = text.replace(/[`"]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}

function buildMermaidGraph(summary: Summary): string {
  const root = escapeMermaidLabel(summary.title_display, 16) || "影片重點";
  const branches = summary.key_points
    .slice(0, 5)
    .map((kp) => {
      const label = escapeMermaidLabel(kp.label, 10) || "重點";
      const content = escapeMermaidLabel(kp.content, 36);
      return `    ${label}\n      ${content}`;
    })
    .join("\n");
  return `mindmap
  root((${root}))
${branches}`;
}

/**
 * 填模板:summary + metadata + theme → 完整 card.html 字串。
 * renderCard(Playwright 截圖)和 editor route(可編輯 HTML 匯出)共用。
 */
export function buildCardHtml(
  summary: Summary,
  metadata: VideoMetadata,
  themeOverride?: string,
  includeRecall: boolean = false
): { html: string; theme: CardTheme; layout: SlideId[] } {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  const theme = pickTheme(metadata.video_id, themeOverride);
  const layout = pickLayout(summary.video_genre, includeRecall);

  let html = template;
  html = html.replace(/\{\{channel\}\}/g, metadata.channel);
  html = html.replace(/\{\{duration\}\}/g, metadata.duration_display);
  html = html.replace(/\{\{title_display\}\}/g, summary.title_display);
  html = html.replace(/\{\{one_liner\}\}/g, summary.one_liner);
  html = html.replace(/\{\{tldr_paragraph\}\}/g, summary.tldr_paragraph || summary.one_liner);
  html = html.replace(/\{\{key_points_html\}\}/g, buildKeyPointsHtml(summary.key_points));
  html = html.replace(/\{\{key_quote\}\}/g, summary.key_quote);
  html = html.replace(/\{\{action_items_html\}\}/g, buildActionItemsHtml(summary.action_items));
  html = html.replace(/\{\{timeline_html\}\}/g, buildTimelineHtml(summary.highlights));
  html = html.replace(/\{\{pitfalls_html\}\}/g, buildPitfallsHtml(summary.pitfalls));
  html = html.replace(/\{\{recall_questions_html\}\}/g, buildRecallHtml(summary.recall_questions));
  html = html.replace(/\{\{tags_html\}\}/g, buildTagsHtml(summary.tags));
  html = html.replace(/\{\{tags_pill_html\}\}/g, buildTagsPillHtml(summary.tags));
  html = html.replace(/\{\{video_title\}\}/g, metadata.title);
  html = html.replace(/\{\{transcript_source\}\}/g, metadata.transcript_source);
  html = html.replace(/\{\{mermaid_graph\}\}/g, buildMermaidGraph(summary));
  html = html.replace(/\{\{theme_css\}\}/g, buildThemeCss(theme));
  html = html.replace(/\{\{accent_hex\}\}/g, theme.accent);
  html = html.replace(/\{\{accent_light_hex\}\}/g, theme.accentLight);

  return { html, theme, layout };
}

export async function renderCard(
  summary: Summary,
  metadata: VideoMetadata,
  outputDir: string,
  themeOverride?: string,
  includeRecall: boolean = false
): Promise<string[]> {
  const { html, layout } = buildCardHtml(summary, metadata, themeOverride, includeRecall);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();

  fs.mkdirSync(outputDir, { recursive: true });
  const paths: string[] = [];

  // viewport 高度按 layout 實際長度 + buffer (card.html 內所有卡都會渲染,但只截 layout 內的)
  const allSlideCount = 9; // card.html 實際 render 出來的卡數量 (含未列入 layout 的也存在 DOM 內)
  const page = await browser.newPage({
    viewport: { width: 1080, height: 1350 * allSlideCount + 40 * (allSlideCount + 1) },
  });
  await page.setContent(html, { waitUntil: "networkidle" });

  // === 動態注入 page-indicator dots ===
  // 因為 layout 是動態的,active dot 位置跟 dots 數量都依 layout 決定
  await page.evaluate((layoutIds) => {
    layoutIds.forEach((slideId, i) => {
      const card = document.querySelector(`[data-slide-id="${slideId}"]`);
      const indicator = card?.querySelector(".page-indicator");
      if (!indicator) return;
      indicator.innerHTML = layoutIds
        .map((_, j) => `<div class="dot${j === i ? " active" : ""}"></div>`)
        .join("");
    });
  }, layout);

  // === Layer 8 護城河:每張卡注入品牌浮水印 (右下角小字) ===
  // 自架版學員拿掉這個 = 違反授權,有法律依據。
  // 文字可由 env CARD_WATERMARK 覆寫,預設 vjvan.com · P2P AI Lab
  const watermark = process.env.CARD_WATERMARK || "vjvan.com · P2P AI Lab";
  await page.evaluate((wm) => {
    // 注入全域 CSS 給浮水印用
    const style = document.createElement("style");
    style.textContent = `
      .card-watermark {
        position: absolute;
        bottom: 14px;
        right: 24px;
        font-family: 'Inter', 'Noto Sans TC', sans-serif;
        font-size: 13px;
        font-weight: 600;
        color: rgba(0, 0, 0, 0.32);
        letter-spacing: 0.5px;
        z-index: 5;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
    document.querySelectorAll(".card").forEach((card) => {
      const el = document.createElement("div");
      el.className = "card-watermark";
      el.textContent = wm;
      card.appendChild(el);
    });
  }, watermark);

  // === 等 Mermaid render 完 (僅當 mindmap 在 layout 內才等) ===
  if (layout.includes("mindmap")) {
    try {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-slide-id="mindmap"] .mermaid svg');
          return !!el && (el as SVGElement).getBoundingClientRect().height > 0;
        },
        { timeout: 15000 }
      );
    } catch {
      console.warn("[render-card] Mermaid SVG 未在 15s 內 render,mindmap 可能空白");
    }
  }

  // === 依 layout 順序截圖,輸出 slide-1.png 到 slide-N.png ===
  for (let i = 0; i < layout.length; i++) {
    const slideId = layout[i];
    const slide = page.locator(`[data-slide-id="${slideId}"]`);
    const outputPath = path.join(outputDir, `slide-${i + 1}.png`);
    try {
      await slide.screenshot({ path: outputPath });
      paths.push(outputPath);
    } catch (err) {
      console.warn(`[render-card] 截圖 ${slideId} (slot ${i + 1}) 失敗:`, err);
    }
  }

  await browser.close();
  return paths;
}
