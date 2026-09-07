import fs from "fs";
import path from "path";
import { SOCIAL_CARD_COUNT, type Summary, type SocialCard, type ActionItem, type Pitfall, type Highlight, type VideoGenre } from "./extract-summary";
import type { VideoMetadata } from "./fetch-transcript";
import type { Browser } from "playwright";

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "card.html");

import { CARD_THEMES, FONT_PRESETS, FONT_FACE_CSS, resolveCardStyle, buildStyleCss, type CardStyle, type CardTheme } from "../card-style";
export * from "../card-style";

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
export type SlideId = string;
type LegacySlideId =
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
export function pickLegacyLayout(genre: VideoGenre, includeRecall: boolean): LegacySlideId[] {
  const layouts: Record<VideoGenre, LegacySlideId[]> = {
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

function trimCardText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join("")}…`;
}

function fallbackSocialCards(summary: Summary): SocialCard[] {
  const keyPoints = summary.key_points.length ? summary.key_points : [{ label: "核心主張", content: summary.one_liner }];
  const questions = summary.recall_questions.length ? summary.recall_questions : ["這套方法成立的條件是什麼？"];
  const actions = summary.action_items.length ? summary.action_items : [{ action: "回到原片核對", expected_outcome: "找出主張與證據的連結", time_estimate: "" }];
  const pitfalls = summary.pitfalls.length ? summary.pitfalls : [{ warn: "只記結論", why: "忽略成立條件，容易把方法套錯情境。" }];
  const isBusiness = (text: string) => /商業|營收|收入|客戶|公司|團隊|員工|市場|產品|服務|訂閱|銷售|成長|職位/i.test(text);
  const kp = (index: number) => keyPoints[index % keyPoints.length];
  const cards: SocialCard[] = [
    { role: "hook", eyebrow: "本集核心", title: summary.title_display, body: summary.one_liner || summary.tldr_paragraph, accent: "先看懂，再決定怎麼用" },
    { role: "context", eyebrow: "快速進入狀況", title: "這部影片在談什麼", body: summary.tldr_paragraph || summary.one_liner, accent: "" },
    { role: "thesis", eyebrow: "核心結論", title: summary.one_liner || summary.title_display, body: summary.tldr_paragraph || summary.one_liner, accent: "一句話先抓住主軸" },
  ];
  for (let index = 0; index < 5; index++) {
    const point = kp(index);
    cards.push({ role: isBusiness(`${point.label}${point.content}`) ? "business" : "insight", eyebrow: `關鍵洞察 ${index + 1}`, title: point.label, body: point.content, accent: "" });
  }
  for (let index = 0; index < 5; index++) {
    const point = kp(index);
    const business = isBusiness(`${point.label}${point.content}`);
    cards.push({ role: business ? "business" : "reflection", eyebrow: business ? "商業拆解" : "再想一步", title: business ? `從「${point.label}」看結構` : `「${point.label}」成立的條件`, body: business ? point.content : `回到影片檢查這項主張的條件與限制：${point.content}`, accent: business ? "看收入，也看交付方式" : "不要只抄結論" });
  }
  for (let index = 0; index < 3; index++) {
    const action = actions[index % actions.length];
    const question = questions[index % questions.length];
    cards.push({ role: index < actions.length ? "action" : "reflection", eyebrow: index < actions.length ? `實作 ${index + 1}` : "自我測驗", title: index < actions.length ? action.action : question, body: index < actions.length ? (action.expected_outcome || "用影片裡的方法完成一次最小實作，再比較前後差異。") : "先不用看答案，試著用自己的話回答，再回原片核對。", accent: index < actions.length ? action.expected_outcome : "能說清楚，才是真的學會" });
  }
  const pitfall = pitfalls[0];
  cards.push({ role: "warning", eyebrow: "容易踩雷", title: pitfall.warn, body: pitfall.why, accent: "先看限制，再談複製" });
  cards.push({ role: summary.key_quote ? "quote" : "evidence", eyebrow: summary.key_quote ? "一句記住" : "具體證據", title: summary.key_quote || kp(1).label, body: summary.key_quote ? "這句話濃縮了整部影片的核心立場。" : kp(1).content, accent: "" });
  cards.push({ role: "recap", eyebrow: "帶走這些", title: "把 20 頁收斂成一件事", body: keyPoints.slice(0, 3).map((point) => point.label).join("、"), accent: summary.one_liner });
  cards.push({ role: "closing", eyebrow: "下一步", title: "收藏，然後回到原片驗證", body: "選一個最有用的觀點，回看對應段落，寫下它適用的情境與下一個動作。", accent: "把內容變成自己的方法" });
  return cards.slice(0, SOCIAL_CARD_COUNT).map((card) => ({
    ...card,
    eyebrow: trimCardText(card.eyebrow, 12),
    title: trimCardText(card.title, 30),
    body: trimCardText(card.body, 110),
    accent: trimCardText(card.accent, 24),
  }));
}

export function resolveSocialCards(summary: Summary): SocialCard[] {
  const cards = Array.isArray(summary.social_cards) && summary.social_cards.length === SOCIAL_CARD_COUNT
    ? summary.social_cards
    : fallbackSocialCards(summary);
  if (cards.length !== SOCIAL_CARD_COUNT) throw new Error("社群學習卡必須完整產生20頁。");
  return cards;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function socialSlideId(index: number): SlideId {
  return `social-${String(index + 1).padStart(2, "0")}`;
}

function buildSocialCardsHtml(cards: SocialCard[], metadata: VideoMetadata, backgroundClass: string): string {
  return cards.map((rawCard, index) => {
    const card = {
      ...rawCard,
      eyebrow: trimCardText(rawCard.eyebrow, 12),
      title: trimCardText(rawCard.title, 30),
      body: trimCardText(rawCard.body, 110),
      accent: trimCardText(rawCard.accent, 24),
    };
    const role = /^[a-z-]+$/.test(card.role) ? card.role : "insight";
    const accent = card.accent ? `<div class="social-accent">${escapeHtml(card.accent)}</div>` : "";
    return `<article class="card social-card social-card--${role} ${backgroundClass}" data-slide-id="${socialSlideId(index)}">
  <div class="social-top-bar" aria-hidden="true"></div>
  <div class="social-eyebrow">${escapeHtml(card.eyebrow)}</div>
  <div class="social-page">${String(index + 1).padStart(2, "0")} / ${SOCIAL_CARD_COUNT}</div>
  <div class="social-main">
    <h2>${escapeHtml(card.title)}</h2>
    <div class="social-rule"></div>
    <p>${escapeHtml(card.body)}</p>
    ${accent}
  </div>
  <div class="social-footer"><strong>唯捷允雷 VJVAN</strong><span>${escapeHtml(metadata.channel || "影片學習筆記")}</span></div>
  <div class="page-indicator"></div>
</article>`;
  }).join("\n");
}

function buildKeyPointsHtml(points: Summary["key_points"]): string {
  return points
    .slice(0, 5)
    .map(
      (kp) => `<div class="point">
      <div class="point-label">${escapeHtml(kp.label)}</div>
      <div class="point-content">${escapeHtml(kp.content)}</div>
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
        ? `<div class="action-meta">${escapeHtml(meta.join("　·　"))}</div>`
        : "";
      return `<div class="action-item">
      <div class="checkbox"></div>
      <div class="action-body">
        <div class="action-text">${escapeHtml(item.action)}</div>
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
        <div class="timeline-label">${escapeHtml(h.label)}</div>
        <div class="timeline-desc">${escapeHtml(h.description)}</div>
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
      <div class="pitfall-warn">${escapeHtml(p.warn)}</div>
      <div class="pitfall-why">${escapeHtml(p.why)}</div>
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
      <div class="recall-q-text">${escapeHtml(q)}</div>
    </div>`
    )
    .join("\n");
}

function buildTagsHtml(tags: string[]): string {
  return tags
    .slice(0, 4)
    .map((t) => `<span class="meta-tag">${escapeHtml(t)}</span>`)
    .join("");
}

function buildTagsPillHtml(tags: string[]): string {
  return tags
    .slice(0, 5)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
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
  styleOverride?: CardStyle | string,
  includeRecall: boolean = false
): { html: string; theme: CardTheme; style: CardStyle; layout: SlideId[] } {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  const style = resolveCardStyle(typeof styleOverride === "string" ? { palette: styleOverride } : styleOverride);
  const theme = CARD_THEMES[style.palette];
  const styleCss = buildStyleCss(style);
  const socialCards = resolveSocialCards(summary);
  const layout = socialCards.map((_, index) => socialSlideId(index));
  void includeRecall;

  const values: Record<string, string> = {
    social_cards_html: buildSocialCardsHtml(socialCards, metadata, styleCss.backgroundClass),
    channel: escapeHtml(metadata.channel),
    duration: escapeHtml(metadata.duration_display),
    title_display: escapeHtml(summary.title_display),
    one_liner: escapeHtml(summary.one_liner),
    tldr_paragraph: escapeHtml(summary.tldr_paragraph || summary.one_liner),
    key_points_html: buildKeyPointsHtml(summary.key_points),
    key_quote: escapeHtml(summary.key_quote),
    action_items_html: buildActionItemsHtml(summary.action_items),
    timeline_html: buildTimelineHtml(summary.highlights),
    pitfalls_html: buildPitfallsHtml(summary.pitfalls),
    recall_questions_html: buildRecallHtml(summary.recall_questions),
    tags_html: buildTagsHtml(summary.tags),
    tags_pill_html: buildTagsPillHtml(summary.tags),
    video_title: escapeHtml(metadata.title),
    transcript_source: escapeHtml(metadata.transcript_source),
    mermaid_graph: escapeHtml(buildMermaidGraph(summary)),
    theme_css: styleCss.css,
    font_face_css: FONT_FACE_CSS,
    accent_hex: theme.accent,
    accent_light_hex: theme.accentLight,
  };
  const html = template.replace(/\{\{([a-z_]+)\}\}/g, (token, key: string) => values[key] ?? token);

  return { html, theme, style, layout };
}

export async function renderCard(
  summary: Summary,
  metadata: VideoMetadata,
  outputDir: string,
  styleOverride?: CardStyle | string,
  includeRecall: boolean = false,
  options?: { scale?: 1 | 2; offline?: boolean; launch?: () => Promise<Pick<Browser, "newPage" | "close">> }
): Promise<string[]> {
  const { html, style, layout } = buildCardHtml(summary, metadata, styleOverride, includeRecall);

  if (!layout.length) throw new Error("圖卡版型為空，不能標記完成。");
  fs.mkdirSync(outputDir, { recursive: true });
  // Do not overwrite earlier complete cards with a half-rendered new set.
  const stagingDir = fs.mkdtempSync(path.join(outputDir, ".render-"));
  let browser: Pick<Browser, "newPage" | "close"> | undefined;
  let failed = true;
  try {
    browser = options?.launch ? await options.launch() : await (await import("playwright")).chromium.launch();
    const paths: string[] = [];

    // 舊版卡片仍保留在模板供歷史相容，但 CSS 已隱藏；實際只渲染固定 20 頁社群卡。
    const allSlideCount = SOCIAL_CARD_COUNT;
    const page = await browser.newPage({
      viewport: { width: 1120, height: 1350 * allSlideCount + 40 * (allSlideCount + 1) },
      deviceScaleFactor: options?.scale ?? 1,
    });
    if (options?.offline) {
      // Deterministic offline verification: no external requests, not a change to OS networking.
      await page.context().setOffline(true);
      await page.route(/^https?:\/\//, route => route.abort("internetdisconnected"));
    }
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    const fontPreset = FONT_PRESETS[style.fontPreset];
    await page.evaluate(async (roles) => {
      const missing: string[] = [];
      for (const [role, font] of Object.entries(roles)) {
        const spec = `${font.weight} 24px "${font.family}"`;
        const probe = role === "mono" ? "VJVAN 0123456789" : "繁體中文學習影片";
        try {
          // check() alone can be true for a nonexistent undeclared family (fallback).
          // Requiring a declared matching face and a successful load closes that loophole.
          const declared = Array.from(document.fonts).filter(face => face.family.replace(/["']/g, "") === font.family && face.weight === String(font.weight));
          const loaded = await document.fonts.load(spec, probe);
          if (!declared.length || !loaded.length || declared.some(face => face.status !== "loaded") || !document.fonts.check(spec, probe)) missing.push(font.family);
        } catch { missing.push(font.family); }
      }
      if (missing.length) throw new Error(`字型未載入，已停止出圖：${[...new Set(missing)].join("、")}。請先安裝本機字型，不允許 fallback。`);
    }, { display: fontPreset.display, body: fontPreset.body, mono: fontPreset.mono });

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
          font-family: var(--social-mono);
          font-size: 13px;
          font-weight: 600;
          color: currentColor;
          opacity: .55;
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
          undefined,
          { timeout: 15000 }
        );
      } catch {
        console.warn("[render-card] Mermaid SVG 未在 15s 內 render,mindmap 可能空白");
      }
    }

    // Every planned card must succeed. Never return [slide-1, slide-3] as two
    // "complete" cards, which callers would incorrectly renumber as slide-1/2.
    for (let i = 0; i < layout.length; i++) {
      const slideId = layout[i];
      const slide = page.locator(`[data-slide-id="${slideId}"]`);
      const outputPath = path.join(stagingDir, `slide-${i + 1}.png`);
      try {
        const clip = await slide.boundingBox();
        if (!clip || clip.width !== 1080 || clip.height !== 1350) throw new Error("invalid card dimensions");
        // page screenshot + deviceScaleFactor preserves the 2x export contract.
        await page.screenshot({ path: outputPath, clip, scale: "device", timeout: 25_000 });
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new Error("empty screenshot");
      } catch {
        throw new Error(`圖卡第 ${i + 1} 張（${slideId}）截圖失敗；未發布不完整圖卡。`);
      }
      paths.push(path.join(outputDir, `slide-${i + 1}.png`));
    }
    if (!paths.length || paths.length !== layout.length) throw new Error("圖卡未完整產生，不能標記完成。");
    for (let i = 0; i < paths.length; i++) fs.renameSync(path.join(stagingDir, `slide-${i + 1}.png`), paths[i]);
    failed = false;
    return paths;
  } finally {
    // newPage / setContent / evaluate failures also close this owned browser.
    try { await browser?.close(); }
    catch (error) { if (!failed) throw error; } // Preserve the original render failure.
    finally { fs.rmSync(stagingDir, { recursive: true, force: true }); }
  }
}
