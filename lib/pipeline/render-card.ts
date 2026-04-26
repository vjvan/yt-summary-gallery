import fs from "fs";
import path from "path";
import type { Summary } from "./extract-summary";
import type { VideoMetadata } from "./fetch-transcript";

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "card.html");
const TOTAL_SLIDES = 5;

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

function buildActionItemsHtml(items: string[]): string {
  return items
    .slice(0, 3)
    .map(
      (item) => `<div class="action-item">
      <div class="checkbox"></div>
      <div class="action-text">${item}</div>
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

export async function renderCard(
  summary: Summary,
  metadata: VideoMetadata,
  outputDir: string
): Promise<string[]> {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");

  let html = template;
  html = html.replace(/\{\{channel\}\}/g, metadata.channel);
  html = html.replace(/\{\{duration\}\}/g, metadata.duration_display);
  html = html.replace(/\{\{title_display\}\}/g, summary.title_display);
  html = html.replace(/\{\{one_liner\}\}/g, summary.one_liner);
  html = html.replace(/\{\{key_points_html\}\}/g, buildKeyPointsHtml(summary.key_points));
  html = html.replace(/\{\{key_quote\}\}/g, summary.key_quote);
  html = html.replace(/\{\{action_items_html\}\}/g, buildActionItemsHtml(summary.action_items));
  html = html.replace(/\{\{tags_html\}\}/g, buildTagsHtml(summary.tags));
  html = html.replace(/\{\{tags_pill_html\}\}/g, buildTagsPillHtml(summary.tags));
  html = html.replace(/\{\{video_title\}\}/g, metadata.title);
  html = html.replace(/\{\{transcript_source\}\}/g, metadata.transcript_source);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();

  fs.mkdirSync(outputDir, { recursive: true });
  const paths: string[] = [];

  const page = await browser.newPage({
    viewport: { width: 1080, height: 1350 * TOTAL_SLIDES + 40 * (TOTAL_SLIDES + 1) },
  });
  await page.setContent(html, { waitUntil: "networkidle" });

  // Screenshot each slide individually
  for (let i = 1; i <= TOTAL_SLIDES; i++) {
    const slide = page.locator(`[data-slide="${i}"]`);
    const outputPath = path.join(outputDir, `slide-${i}.png`);
    await slide.screenshot({ path: outputPath });
    paths.push(outputPath);
  }

  await browser.close();
  return paths;
}
