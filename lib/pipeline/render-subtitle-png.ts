import fs from "fs";
import path from "path";

const SUBTITLE_HTML = (text: string) => `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px;
    height: 240px;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 40px;
  }
  .subtitle-box {
    background: rgba(0, 0, 0, 0.7);
    border-radius: 14px;
    padding: 18px 36px;
    max-width: 1000px;
  }
  .subtitle-text {
    font-family: 'Noto Sans TC', sans-serif;
    font-size: 38px;
    font-weight: 700;
    color: #FFFFFF;
    text-align: center;
    line-height: 1.5;
  }
</style></head>
<body>
  <div class="subtitle-box">
    <div class="subtitle-text">${text}</div>
  </div>
</body></html>`;

/**
 * Batch render subtitle texts as transparent PNGs using a single Playwright instance.
 */
export async function renderSubtitleBatch(
  subtitles: Array<{ text: string; outputPath: string }>
): Promise<string[]> {
  if (subtitles.length === 0) return [];

  for (const sub of subtitles) {
    fs.mkdirSync(path.dirname(sub.outputPath), { recursive: true });
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1080, height: 240 },
  });

  const results: string[] = [];

  for (const sub of subtitles) {
    const html = SUBTITLE_HTML(sub.text);
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.screenshot({ path: sub.outputPath, omitBackground: true });
    results.push(sub.outputPath);
  }

  await browser.close();
  return results;
}
