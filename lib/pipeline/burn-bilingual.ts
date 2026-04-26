/**
 * 雙語字幕燒錄 pipeline
 *
 * 輸入:原始影片 + segments(原文) + segments_zh(中譯,可選)
 * 輸出:三個 SRT 檔 + 一支燒了雙語字幕的 mp4
 *
 * 雙語規則:每段字幕兩行,上 = 原文,下 = 中譯。
 * 若 segments_zh 為 null(原始就是中文),只產一份中文 SRT,單語燒錄。
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { segmentsToSrt, segmentsToVtt } from "./generate-srt";

/**
 * Homebrew 的標準 ffmpeg 沒帶 libass,subtitles filter 不存在。
 * 在 macOS 上偵測 ffmpeg-full,優先用它跑 subtitles 燒錄。
 * 其他 step (audio extract / probe) 仍用標準 ffmpeg。
 */
function resolveFfmpegWithSubtitles(): string {
  if (process.env.FFMPEG_SUB_BIN) return process.env.FFMPEG_SUB_BIN;
  const candidates = [
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "ffmpeg"; // fallback,大概率失敗,但讓使用者看到錯誤訊息
}

interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface SubtitleFiles {
  srtEnPath: string | null;
  srtZhPath: string | null;
  srtBiPath: string;
}

export interface BurnResult extends SubtitleFiles {
  burnedVideoPath: string;
}

function buildBilingualSegments(en: Segment[], zh: Segment[]): Segment[] {
  // 假設 en 與 zh 是一對一(translateSegments 保證 index 對齊)
  const len = Math.min(en.length, zh.length);
  const out: Segment[] = [];
  for (let i = 0; i < len; i++) {
    out.push({
      start: en[i].start,
      end: en[i].end,
      text: `${en[i].text}\n${zh[i].text}`,
    });
  }
  return out;
}

/**
 * ffmpeg subtitles filter 對路徑中的特殊字元很敏感:
 * - 冒號是 filter option 分隔符,需要 escape 為 \:
 * - 反斜線需要轉成 \\
 * - subtitles filter 的 args parser 不支援單引號 quoting,所以不要試圖 quote
 *   遇到單引號就丟錯,讓使用者改檔名(macOS 一般路徑不會有)
 */
function escapeForFfmpegFilter(p: string): string {
  if (p.includes("'") || p.includes(",")) {
    throw new Error(`subtitle path contains unsupported character, rename file: ${p}`);
  }
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * 用 ffmpeg subtitles filter 將 SRT 燒進影片。
 * style 強制 PingFang TC + 白字 + 黑邊 + 底部對齊。
 *
 * 注意 escape:
 * - filename 中 ":" 要 escape 成 "\:"
 * - force_style 中 "," 要 escape 成 "\,"(否則被 filter graph 當成 filter 分隔符)
 */
function burnSubtitle(
  videoPath: string,
  srtPath: string,
  outputPath: string,
  hwaccel: boolean
): void {
  const ffmpeg = resolveFfmpegWithSubtitles();
  const escapedPath = escapeForFfmpegFilter(srtPath);
  const styleParts = [
    "FontName=PingFang TC",
    "FontSize=20",
    "PrimaryColour=&HFFFFFF&",
    "OutlineColour=&H000000&",
    "BorderStyle=1",
    "Outline=2",
    "Shadow=0",
    "Alignment=2",
    "MarginV=40",
  ];
  const style = styleParts.join("\\,");
  const filter = `subtitles=${escapedPath}:force_style='${style}'`;

  // hwaccel: Mac 用 h264_videotoolbox,4K 60fps 燒字幕從 30+ min 縮到 3-5 min
  // 品質會略遜 libx264 medium crf=20,但對「字幕燒錄」用途足夠
  const videoCodec = hwaccel
    ? "-c:v h264_videotoolbox -b:v 8M -tag:v avc1"
    : "-c:v libx264 -preset medium -crf 20";

  execSync(
    `"${ffmpeg}" -i "${videoPath}" -vf "${filter}" ` +
      `${videoCodec} -c:a copy ` +
      `-movflags +faststart -y "${outputPath}"`,
    { timeout: 3600000, stdio: "pipe" }
  );
}

export interface SubtitleInput {
  segments: Segment[];
  segmentsZh: Segment[] | null;
  wasTranslated: boolean;
  outputDir: string;
  contentId: string;
}

/**
 * 只寫 SRT 三檔(英 / 中 / 雙語),不燒錄。
 * 這是主 pipeline 用的快路徑:轉錄+翻譯完立刻能下載字幕。
 */
export function writeSubtitleFiles(input: SubtitleInput): SubtitleFiles {
  const { segments, segmentsZh, wasTranslated, outputDir, contentId } = input;
  fs.mkdirSync(outputDir, { recursive: true });

  let srtEnPath: string | null = null;
  let srtZhPath: string | null = null;
  let srtBiPath: string;

  // 同名寫 SRT + VTT,VTT 給 HTML5 <track> 用,SRT 給 VLC/IINA 用
  const writeBoth = (basePath: string, segs: Segment[]) => {
    fs.writeFileSync(basePath, segmentsToSrt(segs), "utf-8");
    const vttPath = basePath.replace(/\.srt$/, ".vtt");
    fs.writeFileSync(vttPath, segmentsToVtt(segs), "utf-8");
  };

  if (wasTranslated && segmentsZh && segmentsZh.length > 0) {
    srtEnPath = path.join(outputDir, `${contentId}.en.srt`);
    srtZhPath = path.join(outputDir, `${contentId}.zh.srt`);
    srtBiPath = path.join(outputDir, `${contentId}.bi.srt`);

    writeBoth(srtEnPath, segments);
    writeBoth(srtZhPath, segmentsZh);
    writeBoth(srtBiPath, buildBilingualSegments(segments, segmentsZh));
  } else {
    srtBiPath = path.join(outputDir, `${contentId}.srt`);
    srtZhPath = srtBiPath;
    writeBoth(srtBiPath, segments);
  }

  return { srtEnPath, srtZhPath, srtBiPath };
}

export interface BurnInput {
  videoPath: string;
  srtPath: string; // 已寫好的雙語(或單語)SRT 路徑
  outputDir: string;
  contentId: string;
  hwaccel?: boolean; // Mac 用 h264_videotoolbox,速度快 5-10x
}

/**
 * 燒字幕到影片(獨立 step,on-demand 觸發)。
 */
export async function burnSubtitleToVideo(input: BurnInput): Promise<string> {
  const { videoPath, srtPath, outputDir, contentId, hwaccel = true } = input;
  fs.mkdirSync(outputDir, { recursive: true });
  const burnedVideoPath = path.join(outputDir, `${contentId}.burned.mp4`);
  burnSubtitle(videoPath, srtPath, burnedVideoPath, hwaccel);
  return burnedVideoPath;
}

/**
 * 從影片抽出純音軌(給 Whisper 用)。
 * 單聲道 16kHz mp3,大幅縮小檔案,Whisper 也夠用。
 */
export function extractAudioFromVideo(videoPath: string, outputPath: string): string {
  execSync(
    `ffmpeg -i "${videoPath}" -vn -ac 1 -ar 16000 -b:a 64k -y "${outputPath}"`,
    { timeout: 600000, stdio: "pipe" }
  );
  return outputPath;
}
