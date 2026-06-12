/**
 * 燒錄啟動邏輯(burn route 與 auto-burn 共用)。
 *
 * 三種語系獨立燒錄、獨立輸出檔、獨立 URL 欄位:
 *   bi → {contentId}.burned.mp4     → burned_video_url (沿用舊欄位,既有資料不變)
 *   zh → {contentId}.burned.zh.mp4  → burned_zh_url
 *   en → {contentId}.burned.en.mp4  → burned_en_url
 *
 * burn_status / burn_error 仍是單槽(一次只燒一支,ffmpeg 會吃滿 CPU/GPU),
 * burn_track 記錄目前在燒哪個語系。
 */

import path from "path";
import fs from "fs";
import { getDb, SummaryRow } from "@/lib/db";
import { burnSubtitleToVideo } from "./burn-bilingual";

export type BurnTrack = "bi" | "zh" | "en";

interface TrackConfig {
  srtCol: "srt_bi_path" | "srt_zh_path" | "srt_en_path";
  urlCol: "burned_video_url" | "burned_zh_url" | "burned_en_url";
  suffix: string;
  label: string;
}

const TRACK_CONFIG: Record<BurnTrack, TrackConfig> = {
  bi: { srtCol: "srt_bi_path", urlCol: "burned_video_url", suffix: "", label: "雙語" },
  zh: { srtCol: "srt_zh_path", urlCol: "burned_zh_url", suffix: ".zh", label: "中文" },
  en: { srtCol: "srt_en_path", urlCol: "burned_en_url", suffix: ".en", label: "英文" },
};

export function isBurnTrack(v: unknown): v is BurnTrack {
  return v === "bi" || v === "zh" || v === "en";
}

export interface StartBurnResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 驗證 + 啟動背景燒錄。同步回傳可直接轉成 HTTP response 的結果。
 */
export function startBurn(row: SummaryRow, track: BurnTrack, hwaccel: boolean): StartBurnResult {
  const cfg = TRACK_CONFIG[track];

  if (!row.is_video) return { status: 400, body: { error: "Not a video" } };
  if (!row.video_url) return { status: 400, body: { error: "No source video" } };

  const srtRel = row[cfg.srtCol];
  if (!srtRel) {
    return {
      status: 400,
      body: { error: track === "en" ? "此影片沒有獨立英文字幕(未翻譯的影片只有單一字幕)" : "No SRT yet" },
    };
  }

  if (row.burn_status === "burning") {
    return { status: 200, body: { status: "burning", track: row.burn_track, message: "已有燒錄進行中,等它完成再燒下一個語系" } };
  }
  const existingUrl = row[cfg.urlCol];
  if (existingUrl) {
    return { status: 200, body: { status: "done", burned_video_url: existingUrl, track } };
  }

  const publicDir = path.join(process.cwd(), "public");
  const videoPath = path.join(publicDir, row.video_url.replace(/^\//, ""));
  const srtPath = path.join(publicDir, srtRel.replace(/^\//, ""));
  const outputDir = path.join(publicDir, "burned", row.video_id);

  if (!fs.existsSync(videoPath)) {
    return { status: 410, body: { error: `Source video missing: ${videoPath}` } };
  }
  if (!fs.existsSync(srtPath)) {
    return { status: 410, body: { error: `SRT missing: ${srtPath}` } };
  }

  const db = getDb();
  db.prepare("UPDATE summaries SET burn_status = 'burning', burn_error = NULL, burn_track = ? WHERE id = ?")
    .run(track, row.id);

  // Async,呼叫端立刻拿 202
  (async () => {
    try {
      const burnedPath = await burnSubtitleToVideo({
        videoPath,
        srtPath,
        outputDir,
        contentId: row.video_id,
        hwaccel,
        outputSuffix: cfg.suffix,
      });
      const publicUrl = "/" + path.relative(publicDir, burnedPath).split(path.sep).join("/");
      // urlCol 來自固定的 TRACK_CONFIG,不是使用者輸入,可安全插入 SQL
      getDb()
        .prepare(`UPDATE summaries SET burn_status = 'done', ${cfg.urlCol} = ? WHERE id = ?`)
        .run(publicUrl, row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "burn failed";
      getDb()
        .prepare("UPDATE summaries SET burn_status = 'error', burn_error = ? WHERE id = ?")
        .run(message.slice(0, 500), row.id);
    }
  })().catch(() => { /* swallow */ });

  return { status: 202, body: { status: "burning", track, hwaccel } };
}

/**
 * pipeline 完成後檢查 auto_burn,有就觸發燒錄。
 * upload route(影片完成時)與 resume.ts(重啟續跑完成時)都會呼叫。
 */
export function maybeAutoBurn(rowId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT * FROM summaries WHERE id = ?").get(rowId) as SummaryRow | undefined;
  if (!row || row.status !== "done" || !row.is_video) return;
  if (!isBurnTrack(row.auto_burn)) return;

  const result = startBurn(row, row.auto_burn, true);
  console.log(`[auto-burn] ${row.title} track=${row.auto_burn} →`, JSON.stringify(result.body).slice(0, 150));
}
