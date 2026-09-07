import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { ensureSummaryShape, type Summary } from "@/lib/pipeline/extract-summary";
import { buildCardHtml } from "@/lib/pipeline/render-card";
import { CARD_THEMES, FONT_PRESETS, BACKGROUNDS, buildStyleCss, resolveCardStyle, cardStyleOverrides, CardStyleError, type CardStyle } from "@/lib/card-style";
import { buildCaption } from "@/lib/pipeline/build-caption";
import type { VideoMetadata } from "@/lib/pipeline/fetch-transcript";

/**
 * GET /api/summaries/{id}/editor
 *
 * 可編輯 HTML 卡片匯出(aivan-slide-studio 工作流整合)。
 *
 * 把這支影片的卡片組(card.html 同款設計)包成一個「可直接編輯」的單頁 HTML:
 * - 所有文字 contenteditable,點了就改(改錯字 / 調語氣不用重跑 GPT)
 * - 三軸樣式即時預覽（DB/query 是載入預設）
 * - 每張卡單獨匯出 PNG(html-to-image,1080x1350 原尺寸)
 * - 一鍵複製貼文文案
 * - 「下載 HTML」把目前編輯狀態存成獨立單檔,離線可繼續編輯
 * - 編輯自動存 localStorage(同 slide-studio 的 state 持久化理念)
 *
 * ?palette=&font=&bg= 覆寫 / ?theme= 相容別名 / ?preview=1 靜態單卡 / ?download=1 匯出
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.summary) return NextResponse.json({ error: "尚未產出摘要" }, { status: 400 });

  const summary: Summary = ensureSummaryShape(JSON.parse(row.summary) as Partial<Summary>);
  const metadata: VideoMetadata = {
    video_id: row.video_id,
    title: row.title || "",
    channel: row.channel || "",
    duration: row.duration || 0,
    duration_display: row.duration_display || "",
    upload_date: "",
    thumbnail_url: row.thumbnail_url || "",
    view_count: 0,
    transcript_source: row.transcript_source || "whisper",
  };

  const sp = req.nextUrl.searchParams;
  let style: CardStyle;
  try {
    style = resolveCardStyle(row.card_style, cardStyleOverrides(sp));
  } catch (error) {
    if (error instanceof CardStyleError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const { html, layout } = buildCardHtml(summary, metadata, style, sp.get("recall") === "1");

  // A single, static same-origin card for the live style panel. The parent changes
  // shared CSS variables/classes locally: no re-render API or CDN script needed.
  if (sp.get("preview") === "1") {
    const previewHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace("</head>", `<style>html,body{margin:0!important;padding:0!important;width:1080px!important;height:1350px!important;overflow:hidden!important;display:block!important}.card{display:none!important}.card[data-slide-id="${layout[0]}"]{display:flex!important;margin:0!important}</style></head>`);
    return new NextResponse(previewHtml, { headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; frame-ancestors 'self'",
    } });
  }

  const styleVariants: Record<string, ReturnType<typeof buildStyleCss>> = {};
  for (const palette of Object.keys(CARD_THEMES)) {
    for (const fontPreset of Object.keys(FONT_PRESETS)) {
      for (const background of Object.keys(BACKGROUNDS)) {
        styleVariants[[palette, fontPreset, background].join("|")] = buildStyleCss({ palette, fontPreset, background });
      }
    }
  }

  const config = {
    videoId: row.video_id,
    title: summary.title_display || row.title || "",
    layout,
    activeStyle: style,
    themes: CARD_THEMES,
    fontPresets: FONT_PRESETS,
    backgrounds: BACKGROUNDS,
    styleVariants,
    watermark: process.env.CARD_WATERMARK || "vjvan.com · P2P AI Lab",
    caption: buildCaption(summary, row.title || ""),
  };

  const editorHtml = html.replace("</body>", `${buildEditorShell(config)}\n</body>`);

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (sp.get("download") === "1") {
    headers["Content-Disposition"] = `attachment; filename="cards-${row.video_id}.html"`;
  }
  return new NextResponse(editorHtml, { headers });
}

interface EditorConfig {
  videoId: string;
  title: string;
  layout: string[];
  activeStyle: CardStyle;
  themes: typeof CARD_THEMES;
  fontPresets: typeof FONT_PRESETS;
  backgrounds: typeof BACKGROUNDS;
  styleVariants: Record<string, ReturnType<typeof buildStyleCss>>;
  watermark: string;
  caption: string;
}

function buildEditorShell(config: EditorConfig): string {
  // </script 防 XSS-style 提前閉合;config 內容來自自家 DB,但保險起見照做
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");

  return `
<style id="editor-style">
  body { padding-top: 96px; }
  .editor-toolbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 999;
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 14px 24px;
    background: #111114; color: #fff;
    font-family: 'Inter', 'Noto Sans TC', sans-serif; font-size: 14px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.35);
  }
  .editor-toolbar .et-title { font-weight: 800; margin-right: 8px; }
  .editor-toolbar .et-hint { color: #9ca3af; font-size: 12px; }
  .editor-toolbar select, .editor-toolbar button {
    font: inherit; border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer;
  }
  .editor-toolbar select { background: #2a2a30; color: #fff; }
  .editor-toolbar button { background: #2a2a30; color: #fff; font-weight: 700; }
  .editor-toolbar button:hover { background: #3a3a42; }
  .editor-toolbar button.et-primary { background: #35c486; color: #0b2018; }
  .editor-toolbar button.et-primary:hover { background: #2fb077; }
  [contenteditable="true"]:hover { outline: 2px dashed rgba(53,196,134,0.55); outline-offset: 2px; }
  [contenteditable="true"]:focus { outline: 2px solid #35c486; outline-offset: 2px; }
  .card { position: relative; }
  .editor-card-btn {
    position: absolute; top: 14px; right: 14px; z-index: 50;
    border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer;
    background: rgba(17,17,20,0.82); color: #fff;
    font: 700 13px 'Inter', 'Noto Sans TC', sans-serif;
  }
  .editor-card-btn:hover { background: rgba(17,17,20,0.95); }
  .editor-toast {
    position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
    z-index: 1000; padding: 12px 22px; border-radius: 10px;
    background: #35c486; color: #0b2018;
    font: 700 14px 'Inter', 'Noto Sans TC', sans-serif;
    opacity: 0; transition: opacity 0.25s; pointer-events: none;
  }
  .editor-toast.show { opacity: 1; }
</style>
<script src="https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.min.js"></script>
<script id="editor-script">
(function () {
  var CFG = ${configJson};
  var STORAGE_KEY = "card-editor-" + CFG.videoId;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // === 1. 依 layout 排序並隱藏不在 layout 內的卡 ===
  var body = document.body;
  var cardsById = {};
  $all(".card").forEach(function (card) {
    cardsById[card.getAttribute("data-slide-id")] = card;
    card.style.display = "none";
  });
  CFG.layout.forEach(function (slideId) {
    var card = cardsById[slideId];
    if (!card) return;
    card.style.display = "";
    body.appendChild(card); // 依 layout 順序移到最後 → DOM 順序 = carousel 順序
  });

  // === 2. 還原 localStorage 編輯(若有)===
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && saved.cards) {
      Object.keys(saved.cards).forEach(function (slideId) {
        if (cardsById[slideId]) cardsById[slideId].innerHTML = saved.cards[slideId];
      });
    }
  } catch (e) { /* 壞資料直接略過 */ }

  // === 3. page-indicator dots(同 render-card.ts 的注入邏輯)===
  CFG.layout.forEach(function (slideId, i) {
    var card = cardsById[slideId];
    var indicator = card && card.querySelector(".page-indicator");
    if (!indicator) return;
    indicator.innerHTML = CFG.layout
      .map(function (_, j) { return '<div class="dot' + (j === i ? " active" : "") + '"></div>'; })
      .join("");
  });

  // === 4. 浮水印(Layer 8,同 render-card.ts)===
  var wmStyle = document.createElement("style");
  wmStyle.textContent = ".card-watermark{position:absolute;bottom:14px;right:24px;font-family:var(--social-mono);font-size:13px;font-weight:600;color:currentColor;opacity:.55;letter-spacing:0.5px;z-index:5;pointer-events:none;}";
  document.head.appendChild(wmStyle);
  $all(".card").forEach(function (card) {
    if (card.querySelector(".card-watermark")) return;
    var el = document.createElement("div");
    el.className = "card-watermark";
    el.textContent = CFG.watermark;
    card.appendChild(el);
  });

  // === 5. 文字可編輯:葉節點(無子元素且有文字)開 contenteditable ===
  function enableEditing() {
    $all(".card *").forEach(function (el) {
      if (el.children.length === 0 && el.textContent.trim() && !el.closest(".mermaid") && !el.classList.contains("card-watermark") && !el.classList.contains("editor-card-btn")) {
        el.setAttribute("contenteditable", "true");
      }
    });
  }
  enableEditing();

  // === 6. 自動保存(debounce 600ms)===
  var saveTimer = null;
  document.addEventListener("input", function (e) {
    if (!e.target.closest || !e.target.closest(".card")) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var cards = {};
      Object.keys(cardsById).forEach(function (slideId) {
        cards[slideId] = cardsById[slideId].innerHTML;
      });
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ cards: cards, savedAt: Date.now() })); } catch (e2) {}
      toast("已自動保存");
    }, 600);
  });

  // === 7. PNG 匯出 ===
  var EXPORT_FILTER = function (node) {
    return !(node.classList && (node.classList.contains("editor-card-btn") || node.classList.contains("editor-toolbar")));
  };
  function exportCard(card, index) {
    return htmlToImage
      .toPng(card, { width: 1080, height: 1350, pixelRatio: 1, filter: EXPORT_FILTER })
      .then(function (dataUrl) {
        var a = document.createElement("a");
        a.href = dataUrl;
        a.download = "slide-" + (index + 1) + ".png";
        a.click();
      });
  }
  CFG.layout.forEach(function (slideId, i) {
    var card = cardsById[slideId];
    if (!card) return;
    var btn = document.createElement("button");
    btn.className = "editor-card-btn";
    btn.textContent = "\\u2193 PNG";
    btn.addEventListener("click", function () {
      btn.style.visibility = "hidden";
      exportCard(card, i).finally(function () { btn.style.visibility = ""; toast("slide-" + (i + 1) + ".png 已下載"); });
    });
    card.appendChild(btn);
  });

  // === toast(要在工具列之前建立:初始主題套用就會用到)===
  var toastEl = document.createElement("div");
  toastEl.className = "editor-toast";
  document.body.appendChild(toastEl);
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1800);
  }

  // === 8. 工具列 ===
  var bar = document.createElement("div");
  bar.className = "editor-toolbar";
  bar.innerHTML =
    '<span class="et-title"></span>' +
    '<span class="et-hint">點卡片文字直接編輯,自動保存</span>' +
    '<select id="et-theme" aria-label="配色"></select>' +
    '<select id="et-font" aria-label="字型組"></select>' +
    '<select id="et-bg" aria-label="背景"></select>' +
    '<span class="et-hint">樣式僅預覽；正式套用請回影片頁</span>' +
    '<button id="et-all" class="et-primary">全部匯出 PNG</button>' +
    '<button id="et-caption">複製貼文文案</button>' +
    '<button id="et-html">下載可編輯 HTML</button>' +
    '<button id="et-reset">還原預設</button>';
  document.body.appendChild(bar);

  $(".et-title", bar).textContent = CFG.title;
  var themeSelect = $("#et-theme");
  var fontSelect = $("#et-font");
  var bgSelect = $("#et-bg");
  function setupSelect(select, entries, selected) {
    Object.keys(entries).forEach(function (id) {
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = entries[id].label;
      opt.selected = id === selected;
      select.appendChild(opt);
    });
  }
  setupSelect(themeSelect, CFG.themes, CFG.activeStyle.palette);
  setupSelect(fontSelect, CFG.fontPresets, CFG.activeStyle.fontPreset);
  setupSelect(bgSelect, CFG.backgrounds, CFG.activeStyle.background);
  function applyStyle() {
    var style = { palette: themeSelect.value, fontPreset: fontSelect.value, background: bgSelect.value };
    var resolved = CFG.styleVariants[[style.palette, style.fontPreset, style.background].join("|")];
    if (!resolved) return;
    Object.keys(resolved.variables).forEach(function (key) {
      document.documentElement.style.setProperty(key, resolved.variables[key]);
    });
    var backgroundClasses = Object.keys(CFG.backgrounds).map(function (id) { return CFG.backgrounds[id].className; });
    $all(".social-card").forEach(function (card) {
      backgroundClasses.forEach(function (name) { name.split(/\\s+/).filter(Boolean).forEach(function (c) { card.classList.remove(c); }); });
      resolved.backgroundClass.split(/\\s+/).filter(Boolean).forEach(function (c) { card.classList.add(c); });
    });
    CFG.activeStyle = style;
  }
  [themeSelect, fontSelect, bgSelect].forEach(function (select) {
    select.addEventListener("change", function () { applyStyle(); toast("樣式預覽已更新；尚未套用至影片庫"); });
  });
  // DB/query is authoritative. Never restore legacy localStorage palette/style.
  applyStyle();

  $("#et-all").addEventListener("click", function () {
    var chain = Promise.resolve();
    CFG.layout.forEach(function (slideId, i) {
      var card = cardsById[slideId];
      if (!card) return;
      chain = chain.then(function () { return exportCard(card, i); });
    });
    chain.then(function () { toast("已匯出 " + CFG.layout.length + " 張 PNG"); });
  });

  $("#et-caption").addEventListener("click", function () {
    navigator.clipboard.writeText(CFG.caption).then(function () { toast("文案已複製,IG/Threads 直接貼上"); });
  });

  $("#et-html").addEventListener("click", function () {
    var docHtml = "<!DOCTYPE html>\\n" + document.documentElement.outerHTML;
    var blob = new Blob([docHtml], { type: "text/html;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cards-" + CFG.videoId + ".html";
    a.click();
    toast("可編輯 HTML 已下載");
  });

  $("#et-reset").addEventListener("click", function () {
    if (!confirm("清除所有本機編輯,還原成 AI 產出的原始版本?")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    location.reload();
  });
})();
</script>`;
}
