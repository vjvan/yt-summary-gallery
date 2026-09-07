/** Browser-safe style registry shared by rendering, quick editor and AIVAN Studio.
 * Font roles / CSS aliases: ~/aivan/content/social-posts/assets/_carousel-templates/
 * carousel-kit.css (.hd-buding / .t-gekiran / .hw-li / .t-song), checked 2026-09-07.
 */
export interface CardStyle { palette: string; fontPreset: string; background: string }
export interface FontRole { family: string; weight: number }
export interface FontPreset { id: string; label: string; display: FontRole; body: FontRole; mono: FontRole }
export interface CardBackground { id: string; label: string; cardBg: string; className: string; preview: Record<string, string> }

export interface CardTheme {
  id: string;
  label: string;
  cardBg: string;
  accent: string;
  accentLight: string;
  accentDark: string;
}

export const CARD_THEMES: Record<string, CardTheme> = {
  "editorial-paper": {
    id: "editorial-paper",
    label: "編輯紙墨",
    cardBg: "#F3F1EC",
    accent: "#A83A22",
    accentLight: "#E8DDD6",
    accentDark: "#782718",
  },
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

export const DEFAULT_CARD_STYLE: CardStyle = Object.freeze({ palette: "editorial-paper", fontPreset: "editorial-serif", background: "notebook-warm" });
const mono = { family: "JetBrains Mono", weight: 600 };
export const FONT_PRESETS: Record<string, FontPreset> = {
  "editorial-serif": { id: "editorial-serif", label: "編輯宋體", display: { family: "Source Han Serif TW", weight: 900 }, body: { family: "Source Han Serif TW", weight: 600 }, mono },
  "round-display": { id: "round-display", label: "焦糖布丁", display: { family: "JiaoTangBuDing", weight: 400 }, body: { family: "Source Han Serif TW", weight: 600 }, mono },
  "bold-statement": { id: "bold-statement", label: "激燃宣告", display: { family: "Gekiran", weight: 900 }, body: { family: "Source Han Serif TW", weight: 600 }, mono },
  "handwritten-note": { id: "handwritten-note", label: "粒線手記", display: { family: "Lihsianti", weight: 400 }, body: { family: "Lihsianti", weight: 400 }, mono },
};
export const BACKGROUNDS: Record<string, CardBackground> = {
  "plain-white": { id: "plain-white", label: "純白", cardBg: "#FFFFFF", className: "bg-plain-white", preview: { backgroundColor: "#FFFFFF" } },
  "notebook-warm": { id: "notebook-warm", label: "暖白筆記", cardBg: "#F3F1EC", className: "bg-notebook-warm paper-grain", preview: { backgroundColor: "#F3F1EC", backgroundImage: "radial-gradient(rgba(23,21,15,.12) 1px, transparent 1px)", backgroundSize: "8px 8px" } },
  "notebook-dotted": { id: "notebook-dotted", label: "點線筆記", cardBg: "#F3F1EC", className: "bg-notebook-dotted paper-grain rule-dotted", preview: { backgroundColor: "#F3F1EC", backgroundImage: "radial-gradient(circle at 1px 1px,rgba(23,21,15,.28) 1px,transparent 1.5px)", backgroundSize: "5px 16px" } },
  "grid-vertical": { id: "grid-vertical", label: "直線格紙", cardBg: "#F3F1EC", className: "bg-grid-vertical paper-grain rule-vertical", preview: { backgroundColor: "#F3F1EC", backgroundImage: "repeating-linear-gradient(to right,transparent 0 14px,#c9cdd4 14px 15px)" } },
  "ink-dark": { id: "ink-dark", label: "墨黑反白", cardBg: "#17150F", className: "bg-ink-dark", preview: { backgroundColor: "#17150F" } },
  "paper-fiber": { id: "paper-fiber", label: "纖維紙", cardBg: "#EEEBE4", className: "bg-paper-fiber paper-real", preview: { backgroundColor: "#EEEBE4", backgroundImage: "repeating-linear-gradient(83deg,transparent 0 3px,rgba(120,112,98,.12) 3px 4px)" } },
};

// Explicit local-only faces: missing installed fonts must fail rather than silently render a fallback.
// Local PostScript names checked against the installed font files on 2026-09-07.
export const FONT_FACE_CSS = `
@font-face { font-family: "Source Han Serif TW"; src: local("SourceHanSerifTW-Heavy"), local("Source Han Serif TW Heavy"); font-weight: 900; font-style: normal; font-display: block; }
@font-face { font-family: "Source Han Serif TW"; src: local("SourceHanSerifTW-SemiBold"), local("Source Han Serif TW SemiBold"); font-weight: 600; font-style: normal; font-display: block; }
@font-face { font-family: "JiaoTangBuDing"; src: local("AaJiaoTangBuDing"); font-weight: 400; font-style: normal; font-display: block; }
@font-face { font-family: "Gekiran"; src: local("burnfont-1.1-Black"), local("burnfont-1.1 Black"); font-weight: 900; font-style: normal; font-display: block; }
@font-face { font-family: "Lihsianti"; src: local("lihsianti-Proportional"), local("lihsianti Proportional"); font-weight: 400; font-style: normal; font-display: block; }
@font-face { font-family: "JetBrains Mono"; src: local("JetBrainsMono-Regular"), local("JetBrains Mono Regular"); font-weight: 400; font-style: normal; font-display: block; }
@font-face { font-family: "JetBrains Mono"; src: local("JetBrainsMono-SemiBold"), local("JetBrains Mono SemiBold"); font-weight: 600; font-style: normal; font-display: block; }
@font-face { font-family: "JetBrains Mono"; src: local("JetBrainsMono-Bold"), local("JetBrains Mono Bold"); font-weight: 700; font-style: normal; font-display: block; }
`;
export const CARD_FONT_FACE_CSS = FONT_FACE_CSS;

export class CardStyleError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = "CardStyleError"; }
}
function readStyle(raw: string | Partial<CardStyle> | null | undefined): Partial<CardStyle> {
  if (raw === null || raw === undefined) return {};
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { throw new CardStyleError("card_style 必須是有效的 JSON 樣式物件。"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CardStyleError("card_style 必須是樣式物件。");
  const out: Partial<CardStyle> = {};
  for (const key of ["palette", "fontPreset", "background"] as const) {
    const part = (value as Record<string, unknown>)[key];
    if (part === undefined || part === null) continue;
    if (typeof part !== "string") throw new CardStyleError(`不合法的樣式欄位：${key}`);
    out[key] = part;
  }
  return out;
}
export function resolveCardStyle(raw?: string | Partial<CardStyle> | null, overrides?: Partial<CardStyle>): CardStyle {
  const base = readStyle(raw);
  const override = readStyle(overrides);
  const style = { ...DEFAULT_CARD_STYLE, ...base, ...override };
  for (const [key, registry] of [["palette", CARD_THEMES], ["fontPreset", FONT_PRESETS], ["background", BACKGROUNDS]] as const) {
    // Do not accept inherited Object.prototype keys such as toString / __proto__.
    if (!Object.prototype.hasOwnProperty.call(registry, style[key])) throw new CardStyleError(`不合法的 ${key}：${style[key]}`);
  }
  return style;
}
export function cardStyleOverrides(searchParams: Pick<URLSearchParams, "get">): Partial<CardStyle> {
  const palette = searchParams.get("palette") ?? searchParams.get("theme");
  const fontPreset = searchParams.get("font");
  const background = searchParams.get("bg");
  return { ...(palette !== null ? { palette } : {}), ...(fontPreset !== null ? { fontPreset } : {}), ...(background !== null ? { background } : {}) };
}
export function buildStyleCss(input: CardStyle): { css: string; variables: Record<string, string>; backgroundClass: string } {
  const style = resolveCardStyle(input);
  const palette = CARD_THEMES[style.palette], font = FONT_PRESETS[style.fontPreset], background = BACKGROUNDS[style.background];
  const rgb = [1, 3, 5].map(offset => parseInt(palette.accent.slice(offset, offset + 2), 16)).join(", ");
  const variables: Record<string, string> = {
    "--accent": palette.accent,
    "--accent-light": palette.accentLight,
    "--accent-dark": palette.accentDark,
    "--accent-rgb": rgb,
    "--social-display": `"${font.display.family}"`,
    "--social-serif": `"${font.body.family}"`,
    "--social-mono": `"${font.mono.family}"`,
    "--social-display-weight": String(font.display.weight),
    "--social-body-weight": String(font.body.weight),
    "--social-mono-weight": String(font.mono.weight),
    "--card-bg": background.cardBg,
    // Lihsianti has a smaller optical x-height; compensate without using a fallback font.
    "--social-body-size": font.id === "handwritten-note" ? "46px" : "37px",
    "--social-title-size": font.id === "handwritten-note" ? "95px" : "76px",
    "--social-cover-size": font.id === "handwritten-note" ? "135px" : "108px",
    "--social-quote-size": font.id === "handwritten-note" ? "110px" : "88px",
    "--social-accent-size": font.id === "handwritten-note" ? "47px" : "38px",
    "--social-business-size": font.id === "handwritten-note" ? "102px" : "82px",
  };
  return { css: Object.entries(variables).map(([key, value]) => `${key}: ${value};`).join("\n    "), variables, backgroundClass: background.className };
}
/** Legacy theme-only caller compatibility. Background now has its own independent axis. */
export function pickTheme(videoId: string, override?: string): CardTheme {
  void videoId;
  return CARD_THEMES[resolveCardStyle(undefined, override === undefined ? {} : { palette: override }).palette];
}
