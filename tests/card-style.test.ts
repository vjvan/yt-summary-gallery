import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUNDS, CARD_THEMES, FONT_PRESETS, DEFAULT_CARD_STYLE, FONT_FACE_CSS, CardStyleError, resolveCardStyle, cardStyleOverrides, buildStyleCss } from "../lib/card-style";

test("合法三軸樣式能解析 JSON 與覆寫，保留未覆寫欄位", () => {
  const raw = JSON.stringify({ palette: "wine-cream", fontPreset: "round-display", background: "paper-fiber" });
  assert.deepEqual(resolveCardStyle(raw, { palette: "forest-cream" }), { palette: "forest-cream", fontPreset: "round-display", background: "paper-fiber" });
  for (const palette of Object.keys(CARD_THEMES)) for (const fontPreset of Object.keys(FONT_PRESETS)) for (const background of Object.keys(BACKGROUNDS)) {
    assert.deepEqual(resolveCardStyle({ palette, fontPreset, background }), { palette, fontPreset, background });
  }
});
test("不合法 id 或 malformed JSON 產生明確 400，不回退隱藏錯誤", () => {
  for (const raw of ['{broken', 'null', '[]', '{"palette":8}', '{"background":""}', '{"palette":"toString"}', '{"fontPreset":"__proto__"}', '{"background":"invalid"}']) {
    assert.throws(() => resolveCardStyle(raw), (error: unknown) => error instanceof CardStyleError && error.status === 400, raw);
  }
  assert.throws(() => resolveCardStyle(null, { fontPreset: "nope" }), CardStyleError);
});
test("舊資料 NULL / undefined / 缺欄位使用三軸預設", () => {
  assert.deepEqual(resolveCardStyle(null), DEFAULT_CARD_STYLE);
  assert.deepEqual(resolveCardStyle(undefined), DEFAULT_CARD_STYLE);
  assert.deepEqual(resolveCardStyle('{}'), DEFAULT_CARD_STYLE);
  assert.deepEqual(resolveCardStyle({ fontPreset: "handwritten-note" }), { ...DEFAULT_CARD_STYLE, fontPreset: "handwritten-note" });
});
test("palette 與 background 獨立：換配色不能覆蓋背景底色", () => {
  for (const palette of Object.keys(CARD_THEMES)) {
    const result = buildStyleCss({ palette, fontPreset: "editorial-serif", background: "plain-white" });
    assert.equal(result.variables["--card-bg"], "#FFFFFF");
    assert.equal(result.variables["--accent"], CARD_THEMES[palette].accent);
    assert.equal(result.backgroundClass, "bg-plain-white");
  }
});
test("query 三軸解析與 theme 向下相容；palette 優先，空 id 仍報錯", () => {
  assert.deepEqual(cardStyleOverrides(new URLSearchParams("theme=wine-cream&font=round-display&bg=paper-fiber")), { palette: "wine-cream", fontPreset: "round-display", background: "paper-fiber" });
  assert.deepEqual(cardStyleOverrides(new URLSearchParams("theme=wine-cream&palette=forest-cream")), { palette: "forest-cream" });
  assert.deepEqual(cardStyleOverrides(new URLSearchParams()), {});
  assert.throws(() => resolveCardStyle(null, cardStyleOverrides(new URLSearchParams("bg="))), CardStyleError);
});
test("字型角色與 CSS 使用來源既定名稱、字重，不需要 CDN 或楷書 fallback", () => {
  assert.equal(FONT_PRESETS["editorial-serif"].display.weight, 900);
  assert.equal(FONT_PRESETS["editorial-serif"].body.weight, 600);
  assert.equal(FONT_PRESETS["round-display"].display.family, "JiaoTangBuDing");
  assert.equal(FONT_PRESETS["bold-statement"].display.family, "Gekiran");
  assert.equal(FONT_PRESETS["handwritten-note"].body.family, "Lihsianti");
  assert.match(FONT_FACE_CSS, /local\("burnfont-1.1-Black"\)/);
  assert.doesNotMatch(FONT_FACE_CSS, /url\(|https?:|DFKai|BiauKai/);
  const result = buildStyleCss(DEFAULT_CARD_STYLE);
  assert.equal(result.variables["--social-display"], '"Source Han Serif TW"');
  assert.equal(result.variables["--social-mono"], '"JetBrains Mono"');
});
