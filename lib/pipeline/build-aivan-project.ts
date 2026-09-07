import { buildCaption } from "./build-caption";
import type { Summary } from "./extract-summary";
import {
  buildCardHtml,
  resolveSocialCards,
  type CardTheme,
  type SlideId,
} from "./render-card";
import type { VideoMetadata } from "./fetch-transcript";
import { buildStyleCss, resolveCardStyle, FONT_PRESETS, BACKGROUNDS, type CardStyle } from "../card-style";

const SLIDE_TITLES: Record<string, string> = {
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
  cardStyle?: string | Partial<CardStyle> | null;
  styleOverride?: Partial<CardStyle>;
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
  const cardPattern = /<(?:div|article) class="card[^"]*" data-slide-id="([^"]+)">/g;
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

function studioCss(sourceCss: string): string {
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
.card-watermark {
  position: absolute;
  right: 24px;
  bottom: 14px;
  z-index: 5;
  color: currentColor;
  opacity: .55;
  font-family: var(--social-mono);
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

function socialCardFor(id: SlideId, summary: Summary) {
  const match = id.match(/^social-(\d{2})$/);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return resolveSocialCards(summary)[index] || null;
}

function slideTitle(id: SlideId, summary: Summary): string {
  return socialCardFor(id, summary)?.title || SLIDE_TITLES[id] || summary.title_display;
}

function slideSummary(id: SlideId, summary: Summary): string {
  const social = socialCardFor(id, summary);
  if (social) return `${social.eyebrow}｜${social.body}`;
  if (id === "cover") return summary.one_liner;
  if (id === "tldr") return summary.tldr_paragraph;
  if (id === "quote") return summary.key_quote;
  const title = SLIDE_TITLES[id] || summary.title_display;
  return `${title}｜來源：${summary.title_display}`;
}

function buildSlide(
  id: SlideId,
  index: number,
  cardHtml: string,
  css: string,
  theme: CardTheme,
  style: CardStyle,
  summary: Summary,
  total: number,
  scriptTail: string,
  watermark: string
) {
  const title = id === "cover" ? summary.title_display : slideTitle(id, summary);
  const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const markedHtml = cardHtml.replace(/<\/article>\s*$/, `<div class="card-watermark">${escapeHtml(watermark)}</div></article>`);
  const html = addPageIndicator(markedHtml, index, total) + (id === "mindmap" ? `\n${scriptTail}` : "");

  return {
    id: `slide-${String(index + 1).padStart(2, "0")}-${id}`,
    title,
    summary: slideSummary(id, summary),
    format: "ig-portrait",
    template: "html-import",
    width: 1080,
    height: 1350,
    bg: BACKGROUNDS[style.background].cardBg,
    text: style.background === "ink-dark" ? "#F3F1EC" : "#17150F",
    accent: theme.accent,
    radius: 0,
    font: `"${FONT_PRESETS[style.fontPreset].body.family}"`,
    importKind: "youtube-summary-card-v1",
    metadata: {
      title,
      summary: slideSummary(id, summary),
      sourceSlideId: id,
      cardStyle: style,
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
  const style = resolveCardStyle(options.cardStyle, {
    ...(options.themeOverride !== undefined ? { palette: options.themeOverride } : {}),
    ...options.styleOverride,
  });
  const { html, theme, layout } = buildCardHtml(
    summary,
    metadata,
    style,
    includeRecall
  );
  const cards = new Map(extractCards(html).map((card) => [card.id, card.html]));
  const scriptTail = extractScriptTail(html);
  const css = studioCss(extractStyle(html));

  const slides = layout.map((slideId, index) => {
    const cardHtml = cards.get(slideId);
    if (!cardHtml) throw new Error(`AIVAN Project 轉換失敗：找不到 ${slideId} 卡片`);
    return buildSlide(
      slideId,
      index,
      cardHtml,
      css,
      theme,
      style,
      summary,
      layout.length,
      scriptTail,
      options.watermark || "vjvan.com · P2P AI Lab"
    );
  });

  return {
    schemaVersion: "aivan-slide-project-v1",
    cardStyle: style,
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
      cardStyle: style,
      fontPreset: FONT_PRESETS[style.fontPreset],
      background: BACKGROUNDS[style.background],
      themeId: theme.id,
      themeLabel: theme.label,
      colors: {
        background: BACKGROUNDS[style.background].cardBg,
        accent: theme.accent,
        accentLight: theme.accentLight,
        accentDark: theme.accentDark,
      },
      watermark: options.watermark || "vjvan.com · P2P AI Lab",
    },
    import: {
      cardStyle: style,
      styleVariables: buildStyleCss(style).variables,
      backgroundClass: buildStyleCss(style).backgroundClass,
      kind: "youtube-summary-card-v1",
      css,
    },
    slides,
    assets: [],
    exports: [],
  };
}


/** Apply canonical DB/query style to an existing Studio draft without replacing
 * edited card text, inline positioning or textPatches. Only generated card CSS
 * and background classes are refreshed; unrelated user-created layers stay put.
 */
export function applyCanonicalProjectStyle(
  project: Record<string, unknown>,
  base: ReturnType<typeof buildAivanProject>
): Record<string, unknown> {
  const style = base.cardStyle;
  const backgroundClasses = new Set(Object.values(BACKGROUNDS).flatMap((bg) => bg.className.split(/\s+/)));
  const activeClass = buildStyleCss(style).backgroundClass;
  project.cardStyle = style;
  project.brand = base.brand;
  project.import = base.import;
  if (Array.isArray(project.slides)) {
    for (const slide of project.slides) {
      if (!slide || typeof slide !== "object") continue;
      const record = slide as Record<string, unknown>;
      record.bg = BACKGROUNDS[style.background].cardBg;
      record.font = `"${FONT_PRESETS[style.fontPreset].body.family}"`;
      record.accent = base.brand.colors.accent;
      record.metadata = { ...(record.metadata && typeof record.metadata === "object" ? record.metadata : {}), cardStyle: style };
      if (!Array.isArray(record.elements)) continue;
      for (const layer of record.elements) {
        if (!layer || typeof layer !== "object") continue;
        const element = layer as Record<string, unknown>;
        if (element.type !== "html" || typeof element.html !== "string" || !element.html.includes("social-card")) continue;
        element.css = base.import.css;
        if (!element.html.includes('class="card-watermark"')) {
          const watermark = base.brand.watermark.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          element.html = element.html.replace(/<\/article>\s*$/, `<div class="card-watermark">${watermark}</div></article>`);
        }
        element.html = String(element.html).replace(/class="([^"]*\bsocial-card\b[^"]*)"/g, (_match, classNames: string) => {
          if (!classNames.split(/\s+/).includes("social-card")) return _match;
          const classes = classNames.split(/\s+/).filter((name) => name && !backgroundClasses.has(name));
          return `class="${classes.concat(activeClass.split(/\s+/)).join(" ")}"`;
        });
      }
    }
  }
  return project;
}
