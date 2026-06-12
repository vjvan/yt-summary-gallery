import fs from "fs";
import path from "path";
import { run } from "./run-command";
import { renderSubtitleBatch } from "./render-subtitle-png";
import type { CleanTimeline, SubtitleCue } from "./build-clean-timeline";

interface ClipInfo {
  sort_order: number;
  file_path: string;
  file_name: string;
  duration: number;
}

const AUDIO_EXTS = ["mp3", "m4a", "wav", "ogg", "opus", "aac", "flac"];

async function generateTextCard(
  text: string, outputPath: string, options: { subtext?: string } = {}
): Promise<string> {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@700;900&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1080px; height: 1920px; background: #1a1a1a; display: flex; flex-direction: column;
    align-items: center; justify-content: center; font-family: 'Noto Sans TC', sans-serif;
    color: white; text-align: center; padding: 80px; }
  .main { font-size: 56px; font-weight: 900; line-height: 1.4; }
  .sub { font-size: 28px; font-weight: 700; color: #E8722A; margin-top: 32px; }
  .bar { position: absolute; top: 0; left: 0; right: 0; height: 8px; background: #E8722A; }
</style></head>
<body><div class="bar"></div><div class="main">${text}</div>
${options.subtext ? `<div class="sub">${options.subtext}</div>` : ""}
</body></html>`;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.screenshot({ path: outputPath });
  await browser.close();
  return outputPath;
}

async function imageToVideo(imagePath: string, outputPath: string, dur: number): Promise<string> {
  await run(
    `ffmpeg -loop 1 -i "${imagePath}" -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-c:v libx264 -c:a aac -b:a 128k -ar 44100 -t ${dur} ` +
      `-pix_fmt yuv420p -vf "scale=1080:1920:force_original_aspect_ratio=decrease,` +
      `pad=1080:1920:-1:-1:color=black,fps=30" -shortest -y "${outputPath}"`,
    { timeoutMs: 60000 }
  );
  return outputPath;
}

async function extractSegment(
  sourcePath: string, start: number, end: number,
  outputPath: string, isAudioOnly: boolean
): Promise<string> {
  const duration = end - start;
  if (isAudioOnly) {
    await run(
      `ffmpeg -f lavfi -i "color=c=#1a1a1a:s=1080x1920:d=${duration}:r=30" ` +
        `-ss ${start} -i "${sourcePath}" -t ${duration} ` +
        `-c:v libx264 -c:a aac -b:a 128k -ar 44100 -pix_fmt yuv420p ` +
        `-shortest -y "${outputPath}"`,
      { timeoutMs: 120000 }
    );
  } else {
    await run(
      `ffmpeg -ss ${start} -accurate_seek -i "${sourcePath}" -t ${duration} ` +
        `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,` +
        `pad=1080:1920:-1:-1:color=black,fps=30" ` +
        `-c:v libx264 -c:a aac -b:a 128k -ar 44100 -pix_fmt yuv420p ` +
        `-y "${outputPath}"`,
      { timeoutMs: 120000 }
    );
  }
  return outputPath;
}

/**
 * Verify a video has an audio stream. If not, add silent audio.
 */
async function ensureAudio(videoPath: string): Promise<void> {
  try {
    const probe = (await run(
      `ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "${videoPath}"`,
      { timeoutMs: 5000 }
    )).trim();
    if (!probe) {
      console.warn(`[assemble] No audio in ${path.basename(videoPath)}, adding silent track`);
      const tmpPath = videoPath.replace(".mp4", "-noaudio.mp4");
      fs.renameSync(videoPath, tmpPath);
      await run(
        `ffmpeg -i "${tmpPath}" -f lavfi -i anullsrc=r=44100:cl=stereo ` +
          `-c:v copy -c:a aac -b:a 128k -ar 44100 -shortest -y "${videoPath}"`,
        { timeoutMs: 30000 }
      );
      fs.unlinkSync(tmpPath);
    }
  } catch {}
}

/**
 * Overlay a single subtitle PNG onto a video.
 */
async function overlaySubtitle(videoPath: string, pngPath: string, outputPath: string): Promise<string> {
  await run(
    `ffmpeg -i "${videoPath}" -i "${pngPath}" ` +
      `-filter_complex "[1:v]format=rgba[sub];[0:v][sub]overlay=0:1640:format=auto[vout]" ` +
      `-map "[vout]" -map 0:a -c:v libx264 -c:a aac -b:a 128k -ar 44100 ` +
      `-pix_fmt yuv420p -y "${outputPath}"`,
    { timeoutMs: 120000 }
  );
  return outputPath;
}

/**
 * Assemble video. Strategy: extract all segments first, concat, then overlay subtitles.
 * This ensures audio is never lost during the overlay step.
 */
export async function assembleVideo(
  timeline: CleanTimeline,
  clips: ClipInfo[],
  outputDir: string
): Promise<{ videoPath: string; subtitleCues: SubtitleCue[] }> {
  fs.mkdirSync(outputDir, { recursive: true });
  const workDir = path.join(outputDir, "work");
  fs.mkdirSync(workDir, { recursive: true });

  const rawParts: string[] = [];
  const subtitleCues: SubtitleCue[] = [];
  const segmentDurations: number[] = [];
  let partIndex = 0;

  // === PHASE 1: Extract all segments (no overlay, preserve audio) ===

  // Title card
  console.log("[assemble] Generating title card...");
  const titleImg = await generateTextCard(timeline.hook, path.join(workDir, "title.png"));
  const titleVideo = await imageToVideo(titleImg, path.join(workDir, `raw-${partIndex}.mp4`), 3);
  rawParts.push(titleVideo);
  segmentDurations.push(3);
  subtitleCues.push({ text: timeline.hook, video_start: 0, video_end: 3 });
  partIndex++;

  // Extract each segment
  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    const clip = clips.find((c) => c.sort_order === seg.clip_index);
    if (!clip || !fs.existsSync(clip.file_path)) continue;

    const start = Math.max(0, seg.start);
    const end = Math.min(seg.end, clip.duration);
    if (end <= start) continue;

    const segDuration = end - start;
    const ext = clip.file_name.split(".").pop()?.toLowerCase() || "";
    const isAudioOnly = AUDIO_EXTS.includes(ext);

    console.log(`[assemble] Extract ${i + 1}/${timeline.segments.length}: ${start}s-${end}s (${segDuration.toFixed(1)}s)`);

    const rawPath = path.join(workDir, `raw-${partIndex}.mp4`);
    await extractSegment(clip.file_path, start, end, rawPath, isAudioOnly);
    await ensureAudio(rawPath); // safety: guarantee audio stream exists

    rawParts.push(rawPath);
    segmentDurations.push(segDuration);
    partIndex++;
  }

  // CTA card
  console.log("[assemble] Generating CTA card...");
  const ctaImg = await generateTextCard(timeline.cta, path.join(workDir, "cta.png"));
  const ctaVideo = await imageToVideo(ctaImg, path.join(workDir, `raw-${partIndex}.mp4`), 3);
  rawParts.push(ctaVideo);
  segmentDurations.push(3);

  if (rawParts.length <= 2) {
    throw new Error("No valid segments could be extracted");
  }

  // === PHASE 2: Concat all raw parts (audio-safe) ===
  console.log(`[assemble] Concatenating ${rawParts.length} raw parts...`);
  const concatListPath = path.join(workDir, "concat.txt");
  fs.writeFileSync(concatListPath, rawParts.map((p) => `file '${p}'`).join("\n"));

  const concatPath = path.join(workDir, "concat-raw.mp4");
  await run(
    `ffmpeg -f concat -safe 0 -i "${concatListPath}" ` +
      `-c:v libx264 -c:a aac -b:a 128k -ar 44100 -pix_fmt yuv420p ` +
      `-movflags +faststart -y "${concatPath}"`,
    { timeoutMs: 300000 }
  );

  // === PHASE 3: Overlay subtitles one segment at a time ===
  console.log(`[assemble] Rendering ${timeline.segments.length} subtitle PNGs...`);
  const subtitleJobs = timeline.segments.map((seg, i) => ({
    text: seg.subtitle,
    outputPath: path.join(workDir, `sub-${i}.png`),
  }));
  await renderSubtitleBatch(subtitleJobs);

  // Calculate absolute times for each subtitle in the concatenated video
  let videoTime = 3; // after title card
  const overlaySpecs: Array<{ pngPath: string; start: number; end: number }> = [];

  for (let i = 0; i < timeline.segments.length; i++) {
    const segDur = segmentDurations[i + 1]; // +1 because index 0 is title card
    if (!segDur) continue;

    overlaySpecs.push({
      pngPath: path.join(workDir, `sub-${i}.png`),
      start: videoTime,
      end: videoTime + segDur,
    });

    subtitleCues.push({
      text: timeline.segments[i].subtitle,
      video_start: Math.round(videoTime * 100) / 100,
      video_end: Math.round((videoTime + segDur) * 100) / 100,
    });

    videoTime += segDur;
  }

  // CTA cue
  subtitleCues.push({ text: timeline.cta, video_start: videoTime, video_end: videoTime + 3 });

  // Apply subtitle overlays sequentially on the concatenated video
  // Process in small batches to avoid filter_complex limits
  let currentVideo = concatPath;
  const BATCH_SIZE = 5;

  for (let batch = 0; batch < overlaySpecs.length; batch += BATCH_SIZE) {
    const batchSpecs = overlaySpecs.slice(batch, batch + BATCH_SIZE);
    const isLast = batch + BATCH_SIZE >= overlaySpecs.length;
    const batchOutput = isLast
      ? path.join(outputDir, "remix.mp4")
      : path.join(workDir, `overlay-batch-${batch}.mp4`);

    const inputs = batchSpecs.map((s) => `-i "${s.pngPath}"`).join(" ");
    let filterChain = "";
    let prevLabel = "0:v";

    for (let j = 0; j < batchSpecs.length; j++) {
      const s = batchSpecs[j];
      const outLabel = j === batchSpecs.length - 1 ? "vout" : `v${j}`;
      filterChain +=
        `[${prevLabel}][${j + 1}:v]overlay=0:1640:enable='between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})':format=auto[${outLabel}]`;
      if (j < batchSpecs.length - 1) filterChain += "; ";
      prevLabel = outLabel;
    }

    console.log(`[assemble] Overlay batch ${Math.floor(batch / BATCH_SIZE) + 1}/${Math.ceil(overlaySpecs.length / BATCH_SIZE)}...`);

    await run(
      `ffmpeg -i "${currentVideo}" ${inputs} ` +
        `-filter_complex "${filterChain}" ` +
        `-map "[vout]" -map 0:a -c:v libx264 -c:a aac -b:a 128k -ar 44100 ` +
        `-pix_fmt yuv420p -movflags +faststart -y "${batchOutput}"`,
      { timeoutMs: 300000 }
    );

    currentVideo = batchOutput;
  }

  // If no overlays were done, just copy the concat
  if (overlaySpecs.length === 0) {
    fs.copyFileSync(concatPath, path.join(outputDir, "remix.mp4"));
  }

  // Cleanup
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

  const outputPath = path.join(outputDir, "remix.mp4");
  console.log(`[assemble] Video saved: ${outputPath} (${subtitleCues.length} cues)`);
  return { videoPath: outputPath, subtitleCues };
}
