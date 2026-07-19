import { buildCaption } from "./build-caption";
import type { Summary } from "./extract-summary";
import {
  buildCardHtml,
  type CardTheme,
  type SlideId,
} from "./render-card";
import type { VideoMetadata } from "./fetch-transcript";

const SLIDE_TITLES: Record<SlideId, string> = {
  cover: "封面",
  tldr: "60 秒看懂",
  keypoints: "重點解構",
  timeline: "時間軸",
  actions: "立即動手",
  pitfalls: "陷阱清單",
  quote: "一句記住",
  mindmap: "概念地圖",
  recall: "自我測驗",
};

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface BuildAivanProjectOptions {
  projectId: string;
  sourceUrl: string;
  sourceType: string;
  originalUrl: string;
  createdAt?: string;
  themeOverride?: string;
  includeRecall?: boolean;
  transcriptLanguage?: string;
  outputLanguage?: string;
  transcriptSegments?: TranscriptSegment[];
  watermark?: string;
}

interface CardFragment {
  id: SlideId;
  html: string;
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ");
}

function extractStyle(html: string): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/i);
  if (!match) throw new Error("AIVAN Project 轉換失敗：找不到卡片 CSS");
  return match[1].trim();
}

function extractScriptTail(html: string): string {
  const scriptStart = html.indexOf('<script src="https://cdn.jsdelivr.net/npm/mermaid');
  if (scriptStart < 0) return "";
  const bodyEnd = html.lastIndexOf("</body>");
  return html.slice(scriptStart, bodyEnd > scriptStart ? bodyEnd : undefined).trim();
}

function extractCards(html: string): CardFragment[] {
  const cardPattern = /<div class="card[^"]*" data-slide-id="([^"]+)">/g;
  const matches = Array.from(html.matchAll(cardPattern));
  const scriptStart = html.indexOf('<script src="https://cdn.jsdelivr.net/npm/mermaid');
  const fallbackEnd = scriptStart >= 0 ? scriptStart : html.lastIndexOf("</body>");

  return matches.map((match, index) => {
    const id = match[1] as SlideId;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? fallbackEnd;
    return { id, html: html.slice(start, end).trim() };
  });
}

function addPageIndicator(cardHtml: string, activeIndex: number, total: number): string {
  const dots = Array.from({ length: total }, (_, index) =>
    `<div class="dot${index === activeIndex ? " active" : ""}"></div>`
  ).join("");
  return cardHtml.replace(
    '<div class="page-indicator"></div>',
    `<div class="page-indicator">${dots}</div>`
  );
}

function studioCss(sourceCss: string, watermark: string): string {
  return `${sourceCss}

/* AIVAN Slide Studio HTML layer overrides */
html, body {
  width: 1080px !important;
  height: 1350px !important;
  margin: 0 !important;
  padding: 0 !important;
  display: block !important;
  overflow: hidden !important;
  background: transparent !important;
}
.deck-shell, .deck {
  width: 1080px !important;
  height: 1350px !important;
  margin: 0 !important;
  padding: 0 !important;
}
.card {
  margin: 0 !important;
}
.card::after {
  content: "${escapeCssString(watermark)}";
  position: absolute;
  right: 24px;
  bottom: 14px;
  z-index: 5;
  color: rgba(0, 0, 0, 0.32);
  font-family: 'Inter', 'Noto Sans TC', sans-serif;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
  pointer-events: none;
}`;
}

function evidenceFor(summary: Summary, segments: TranscriptSegment[]) {
  return summary.highlights.map((highlight, index) => {
    const segment = segments.find(
      (candidate) => highlight.timestamp >= candidate.start && highlight.timestamp <= candidate.end
    ) ?? segments.reduce<TranscriptSegment | undefined>((nearest, candidate) => {
      if (!nearest) return candidate;
      return Math.abs(candidate.start - highlight.timestamp) < Math.abs(nearest.start - highlight.timestamp)
        ? candidate
        : nearest;
    }, undefined);

    return {
      id: `evidence-${String(index + 1).padStart(2, "0")}`,
      start: highlight.timestamp,
      end: segment?.end ?? highlight.timestamp,
      label: highlight.label,
      description: highlight.description,
      transcript: segment?.text ?? "",
      claimIds: [],
    };
  });
}

function slideSummary(id: SlideId, summary: Summary): string {
  if (id === "cover") return summary.one_liner;
  if (id === "tldr") return summary.tldr_paragraph;
  if (id === "quote") return summary.key_quote;
  const title = SLIDE_TITLES[id];
  return `${title}｜來源：${summary.title_display}`;
}

function buildSlide(
  id: SlideId,
  index: number,
  cardHtml: string,
  css: string,
  theme: CardTheme,
  summary: Summary,
  total: number,
  scriptTail: string
) {
  const title = id === "cover" ? summary.title_display : SLIDE_TITLES[id];
  const html = addPageIndicator(cardHtml, index, total) + (id === "mindmap" ? `\n${scriptTail}` : "");

  return {
    id: `slide-${String(index + 1).padStart(2, "0")}-${id}`,
    title,
    summary: slideSummary(id, summary),
    format: "ig-portrait",
    template: "html-import",
    width: 1080,
    height: 1350,
    bg: theme.cardBg,
    text: "#1A1A1A",
    accent: theme.accent,
    radius: 0,
    font: "'Noto Sans TC', 'PingFang TC', sans-serif",
    importKind: "youtube-summary-card-v1",
    metadata: {
      title,
      summary: slideSummary(id, summary),
      sourceSlideId: id,
      position: index + 1,
      total,
    },
    elements: [
      {
        id: `html-${id}`,
        type: "html",
        label: `${String(index + 1).padStart(2, "0")}／${String(total).padStart(2, "0")} · ${title}`,
        x: 0,
        y: 0,
        w: 1080,
        h: 1350,
        z: 2,
        html,
        css,
        textPatches: {},
      },
    ],
    patches: { textPatches: {} },
    textPatches: {},
  };
}

/**
 * YT Summary → AIVAN Slide Studio 的第一階段橋接。
 *
 * 先用 HTML layer 保留既有 Carousel 的完整視覺；Studio 會在 iframe 內
 * 動態建立文字節點 ID，因此即使尚未預先產 domMap，也能點文字直接編輯。
 */
export function buildAivanProject(
  summary: Summary,
  metadata: VideoMetadata,
  options: BuildAivanProjectOptions
) {
  const includeRecall = options.includeRecall ?? false;
  const { html, theme, layout } = buildCardHtml(
    summary,
    metadata,
    options.themeOverride,
    includeRecall
  );
  const cards = new Map(extractCards(html).map((card) => [card.id, card.html]));
  const scriptTail = extractScriptTail(html);
  const css = studioCss(
    extractStyle(html),
    options.watermark || "vjvan.com · P2P AI Lab"
  );

  const slides = layout.map((slideId, index) => {
    const cardHtml = cards.get(slideId);
    if (!cardHtml) throw new Error(`AIVAN Project 轉換失敗：找不到 ${slideId} 卡片`);
    return buildSlide(
      slideId,
      index,
      cardHtml,
      css,
      theme,
      summary,
      layout.length,
      scriptTail
    );
  });

  return {
    schemaVersion: "aivan-slide-project-v1",
    id: options.projectId,
    title: summary.title_display || metadata.title,
    description: summary.one_liner,
    created: options.createdAt || new Date().toISOString(),
    updated: new Date().toISOString(),
    currentSlideIndex: 0,
    sourceUrl: options.sourceUrl,
    source: {
      type: options.sourceType || "youtube",
      url: options.originalUrl,
      videoId: metadata.video_id,
      title: metadata.title,
      channel: metadata.channel,
      duration: metadata.duration,
      durationDisplay: metadata.duration_display,
      transcriptSource: metadata.transcript_source,
      transcriptLanguage: options.transcriptLanguage || "auto",
      outputLanguage: options.outputLanguage || "zh-TW",
    },
    strategy: {
      audience: "知識型內容的社群讀者",
      goal: "education",
      tone: "白話、可信、可行動",
      hook: summary.one_liner,
      cta: "收藏並回到影片實作",
      approved: false,
    },
    provenance: {
      promptVersion: summary.prompt_version || null,
      generatedFrom: "yt-summary-gallery",
      evidence: evidenceFor(summary, options.transcriptSegments || []),
    },
    contentPack: {
      caption: buildCaption(summary, metadata.title),
      threads: [],
      shortsScript: "",
      youtubeChapters: summary.highlights.map((highlight) => ({
        timestamp: highlight.timestamp,
        title: highlight.label,
      })),
      lessonOutline: summary.key_points,
    },
    brand: {
      kitId: "aivan-default",
      themeId: theme.id,
      themeLabel: theme.label,
      colors: {
        background: theme.cardBg,
        accent: theme.accent,
        accentLight: theme.accentLight,
        accentDark: theme.accentDark,
      },
      watermark: options.watermark || "vjvan.com · P2P AI Lab",
    },
    import: {
      kind: "youtube-summary-card-v1",
      css,
    },
    slides,
    assets: [],
    exports: [],
  };
}
