"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import TranscriptView from "@/components/TranscriptView";

export default function CardDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [view, setView] = useState<"carousel" | "transcript">("carousel");
  const [loading, setLoading] = useState(true);
  const [initialSeekSec, setInitialSeekSec] = useState<number | null>(null);
  const burnPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 讀 URL hash 拿 #t=153&seg=24
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    const m = hash.match(/[#&]t=(\d+)/);
    if (m) setInitialSeekSec(parseInt(m[1], 10));
  }, []);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/summaries/${id}`);
    const d = await r.json();
    setData(d);
    return d;
  }, [id]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // burn_status=burning 時開 polling
  useEffect(() => {
    const burnStatus = (data?.burn_status as string | null) || null;
    if (burnStatus === "burning" && !burnPollRef.current) {
      burnPollRef.current = setInterval(async () => {
        const d = await refresh();
        if (d.burn_status !== "burning") {
          if (burnPollRef.current) clearInterval(burnPollRef.current);
          burnPollRef.current = null;
        }
      }, 5000);
    }
    return () => {
      if (burnPollRef.current) {
        clearInterval(burnPollRef.current);
        burnPollRef.current = null;
      }
    };
  }, [data, refresh]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-400">載入中...</p>
      </main>
    );
  }

  if (!data || data.error) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-xl text-gray-400 mb-4">找不到這張摘要圖卡</p>
          <Link href="/" className="text-orange-500 hover:underline">
            回首頁
          </Link>
        </div>
      </main>
    );
  }

  const summary = data.summary as Record<string, unknown> | null;
  const cardPaths = (data.card_paths as string[]) || [];
  const segments = (data.segments as { start: number; end: number; text: string }[]) || [];
  const segmentsZh = (data.segments_zh as { start: number; end: number; text: string }[] | null) || null;
  const isTranslated = !!data.is_translated;
  const highlights = ((summary?.highlights as { timestamp: number; label: string; description: string }[]) || []);
  const source = (data.source as string) || "youtube";
  const isVideo = !!data.is_video;
  const burnedVideoUrl = (data.burned_video_url as string | null) || null;
  const videoUrl = (data.video_url as string | null) || null;
  const srtEnPath = (data.srt_en_path as string | null) || null;
  const srtZhPath = (data.srt_zh_path as string | null) || null;
  const srtBiPath = (data.srt_bi_path as string | null) || null;
  const burnStatus = (data.burn_status as string | null) || null;
  const burnError = (data.burn_error as string | null) || null;

  // 偵測翻譯 fallback 比例(段中文跟原文一模一樣 = GPT 漏譯)
  let fallbackRatio = 0;
  if (isTranslated && segmentsZh && segments.length > 0 && segments.length === segmentsZh.length) {
    let fallback = 0;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].text.trim() === segmentsZh[i].text.trim()) fallback++;
    }
    fallbackRatio = fallback / segments.length;
  }

  async function handleBurn(hwaccel: boolean) {
    await fetch(`/api/summaries/${id}/burn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hwaccel }),
    });
    await refresh();
  }

  async function handleRetranslate() {
    if (!confirm("確定要重新翻譯?Whisper 不會重跑,只重翻譯,大概需要 2-3 分鐘。")) return;
    await fetch(`/api/summaries/${id}/retranslate`, { method: "POST" });
    // 開個 polling 直到 fallbackRatio 變動
    const startSnapshot = JSON.stringify(segmentsZh);
    const poll = setInterval(async () => {
      const d = await refresh();
      const newZh = JSON.stringify(d.segments_zh);
      if (newZh !== startSnapshot) clearInterval(poll);
    }, 5000);
    setTimeout(() => clearInterval(poll), 600000);
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className={view === "transcript" ? "max-w-[1600px] mx-auto px-6 py-6" : "max-w-7xl mx-auto px-4 py-8"}>
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <Link
            href="/"
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            &larr; 回到 Gallery
          </Link>

          {/* View toggle */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setView("carousel")}
              className={`px-4 py-2 rounded-md text-sm font-bold transition-colors ${
                view === "carousel"
                  ? "bg-white text-orange-600 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              圖卡 Carousel
            </button>
            <button
              onClick={() => setView("transcript")}
              className={`px-4 py-2 rounded-md text-sm font-bold transition-colors ${
                view === "transcript"
                  ? "bg-white text-orange-600 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              逐字稿同步
            </button>
          </div>
        </div>

        {/* Title */}
        <div className="mb-6">
          <h1 className="text-2xl font-black text-gray-900 mb-1">
            {(summary?.title_display as string) || (data.title as string)}
          </h1>
          <div className="flex items-center gap-3">
            <span className={`text-xs font-bold px-2.5 py-1 rounded-full text-white ${
              source === "video" ? "bg-blue-500" :
              source === "podcast" ? "bg-purple-500" : "bg-red-500"
            }`}>
              {source === "video" ? "影片" : source === "podcast" ? "Podcast" : "YouTube"}
            </span>
            <p className="text-gray-500">
              {data.channel as string} / {data.duration_display as string}
            </p>
          </div>
        </div>

        {/* === CAROUSEL VIEW === */}
        {view === "carousel" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div>
              {cardPaths.length > 0 && (
                <>
                  <div className="rounded-xl overflow-hidden shadow-lg bg-white">
                    <Image
                      src={cardPaths[currentSlide]}
                      alt={`Slide ${currentSlide + 1}`}
                      width={1080}
                      height={1350}
                      className="w-full h-auto"
                    />
                  </div>
                  <div className="flex items-center justify-between mt-4">
                    <button
                      onClick={() => setCurrentSlide(Math.max(0, currentSlide - 1))}
                      disabled={currentSlide === 0}
                      className="px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed font-bold"
                    >
                      &larr;
                    </button>
                    <div className="flex gap-2">
                      {cardPaths.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setCurrentSlide(i)}
                          className={`w-3 h-3 rounded-full transition-all ${
                            i === currentSlide
                              ? "bg-orange-500 w-6"
                              : "bg-gray-300 hover:bg-gray-400"
                          }`}
                        />
                      ))}
                    </div>
                    <button
                      onClick={() => setCurrentSlide(Math.min(cardPaths.length - 1, currentSlide + 1))}
                      disabled={currentSlide === cardPaths.length - 1}
                      className="px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed font-bold"
                    >
                      &rarr;
                    </button>
                  </div>
                  <div className="flex gap-3 mt-4">
                    <a
                      href={cardPaths[currentSlide]}
                      download={`slide-${currentSlide + 1}.png`}
                      className="flex-1 py-3 text-center font-bold text-white bg-orange-500 rounded-lg hover:bg-orange-600 transition-colors"
                    >
                      下載此頁
                    </a>
                    {segments.length > 0 && (
                      <a
                        href={`/api/summaries/${id}/srt`}
                        download
                        className="px-4 py-3 text-center font-bold text-white bg-gray-700 rounded-lg hover:bg-gray-800 transition-colors"
                      >
                        SRT 字幕檔
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>

            <div>
              {source === "youtube" ? (
                <div className="aspect-video rounded-xl overflow-hidden mb-6">
                  <iframe
                    src={`https://www.youtube.com/embed/${data.video_id}`}
                    className="w-full h-full"
                    allowFullScreen
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  />
                </div>
              ) : isVideo ? (
                <VideoPlayerPanel
                  videoUrl={videoUrl}
                  burnedVideoUrl={burnedVideoUrl}
                  srtEnPath={srtEnPath}
                  srtZhPath={srtZhPath}
                  srtBiPath={srtBiPath}
                  isTranslated={isTranslated}
                  burnStatus={burnStatus}
                  burnError={burnError}
                  fallbackRatio={fallbackRatio}
                  initialSeekSec={initialSeekSec}
                  onBurn={handleBurn}
                  onRetranslate={handleRetranslate}
                />
              ) : (
                <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-6 mb-6">
                  <p className="text-purple-600 font-bold text-lg mb-3 text-center">Podcast 音訊</p>
                  {typeof data.audio_url === "string" && data.audio_url && (
                    <audio
                      src={data.audio_url}
                      controls
                      className="w-full mb-3"
                    />
                  )}
                  {typeof data.url === "string" && data.url && !data.url.startsWith("upload://") && (
                    <a
                      href={data.url as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-center text-sm text-purple-500 hover:underline"
                    >
                      前往原始來源
                    </a>
                  )}
                </div>
              )}
              <SummaryPanel summary={summary} />
            </div>
          </div>
        )}

        {/* === TRANSCRIPT SYNC VIEW === */}
        {view === "transcript" && (
          <TranscriptView
            segments={segments}
            segmentsZh={segmentsZh}
            highlights={highlights}
            videoId={data.video_id as string}
            isTranslated={isTranslated}
            summary={summary}
            source={source}
            podcastUrl={source === "podcast" ? ((data.audio_url as string) || undefined) : undefined}
          />
        )}
      </div>
    </main>
  );
}

/**
 * SRT 經 /api/srt-as-vtt 即時轉成 WebVTT 給 <track> 用。
 * 這個 HTML5 video 預覽不依賴燒錄,字幕 ready 立刻能看。
 */
function VideoPlayerPanel({
  videoUrl,
  burnedVideoUrl,
  srtEnPath,
  srtZhPath,
  srtBiPath,
  isTranslated,
  burnStatus,
  burnError,
  fallbackRatio,
  initialSeekSec,
  onBurn,
  onRetranslate,
}: {
  videoUrl: string | null;
  burnedVideoUrl: string | null;
  srtEnPath: string | null;
  srtZhPath: string | null;
  srtBiPath: string | null;
  isTranslated: boolean;
  burnStatus: string | null;
  burnError: string | null;
  fallbackRatio: number;
  initialSeekSec: number | null;
  onBurn: (hwaccel: boolean) => void;
  onRetranslate: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // 從 /search 跳過來時 hash 帶 #t=153,在 video metadata 載入後 seek 並 play
  useEffect(() => {
    const v = videoRef.current;
    if (!v || initialSeekSec === null) return;
    const seek = () => {
      try {
        v.currentTime = initialSeekSec;
        v.play().catch(() => { /* autoplay 被擋,沒關係,使用者按 play 即可 */ });
      } catch { /* ignore */ }
    };
    if (v.readyState >= 1) {
      seek();
    } else {
      v.addEventListener("loadedmetadata", seek, { once: true });
      return () => v.removeEventListener("loadedmetadata", seek);
    }
  }, [initialSeekSec]);
  const playSrc = burnedVideoUrl || videoUrl || "";
  const showSoftSubs = !burnedVideoUrl; // 已燒就不掛 track,避免雙重字幕
  const vttBi = srtBiPath ? srtToVttUrl(srtBiPath) : null;
  const vttEn = srtEnPath ? srtToVttUrl(srtEnPath) : null;
  const vttZh = srtZhPath && srtZhPath !== srtBiPath ? srtToVttUrl(srtZhPath) : null;

  const downloads: { href: string; label: string; primary?: boolean }[] = [];
  if (burnedVideoUrl) downloads.push({ href: burnedVideoUrl, label: "下載已燒字幕影片 mp4", primary: true });
  if (videoUrl) downloads.push({ href: videoUrl, label: "下載原始影片 mp4" });
  if (srtBiPath && isTranslated && srtBiPath !== srtZhPath) downloads.push({ href: srtBiPath, label: "雙語 SRT(VLC/IINA 掛字幕用)" });
  if (srtEnPath && isTranslated) downloads.push({ href: srtEnPath, label: "原文 SRT" });
  if (srtZhPath) downloads.push({ href: srtZhPath, label: isTranslated ? "中譯 SRT" : "字幕 SRT" });

  return (
    <div className="mb-6">
      <div className="rounded-xl overflow-hidden bg-black mb-3">
        <video ref={videoRef} src={playSrc} controls crossOrigin="anonymous" className="w-full h-auto">
          {showSoftSubs && vttBi && (
            <track src={vttBi} kind="subtitles" srcLang="zh" label="雙語" default />
          )}
          {showSoftSubs && vttEn && (
            <track src={vttEn} kind="subtitles" srcLang="en" label="English" />
          )}
          {showSoftSubs && vttZh && (
            <track src={vttZh} kind="subtitles" srcLang="zh-TW" label="繁中" />
          )}
        </video>
      </div>

      {showSoftSubs && srtBiPath && (
        <p className="text-xs text-center text-gray-400 mb-3">
          字幕已即時掛上(瀏覽器原生)。要更換軌道請點 player 右下角字幕按鈕
        </p>
      )}
      {burnedVideoUrl && (
        <p className="text-xs text-center text-gray-400 mb-3">已燒上雙語字幕</p>
      )}

      {/* 翻譯品質指示 + 重翻按鈕 */}
      {isTranslated && fallbackRatio > 0.05 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-4">
          <p className="text-sm text-amber-800 font-bold mb-1">
            翻譯品質警告:約 {(fallbackRatio * 100).toFixed(0)}% 段未翻譯成功
          </p>
          <p className="text-xs text-amber-700 mb-3">
            部分段落字幕仍是英文(GPT 翻譯時被截斷)。已自動修補批次大小,點下方按鈕可重翻一次。
          </p>
          <button
            onClick={onRetranslate}
            className="w-full py-2.5 font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors text-sm"
          >
            重新翻譯(2-3 分鐘)
          </button>
        </div>
      )}
      {isTranslated && fallbackRatio === 0 && (
        <p className="text-xs text-center text-green-600 mb-3">翻譯完整度 100%</p>
      )}

      <div className="space-y-2 mb-4">
        {downloads.map((it) => (
          <a
            key={it.href}
            href={it.href}
            download
            className={`block w-full py-3 text-center font-bold rounded-lg transition-colors ${
              it.primary
                ? "text-white bg-blue-500 hover:bg-blue-600"
                : "text-gray-700 bg-gray-100 hover:bg-gray-200"
            }`}
          >
            {it.label}
          </a>
        ))}
      </div>

      {/* 燒字幕按鈕區 */}
      {!burnedVideoUrl && srtBiPath && (
        <div className="border-t pt-4">
          {burnStatus === "burning" && (
            <div className="text-center py-3 px-4 bg-orange-50 rounded-lg">
              <span className="inline-block w-4 h-4 mr-2 border-2 border-orange-400 border-t-transparent rounded-full animate-spin align-middle" />
              <span className="text-sm text-orange-700 font-bold">字幕燒錄中(背景進行,可關閉頁面)</span>
            </div>
          )}
          {burnStatus === "error" && (
            <div className="text-center py-3 px-4 bg-red-50 rounded-lg mb-3">
              <p className="text-sm text-red-600 font-bold">燒錄失敗</p>
              <p className="text-xs text-red-500 mt-1">{burnError}</p>
            </div>
          )}
          {burnStatus !== "burning" && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 text-center mb-2">
                把字幕燒進影片(輸出可分享給沒裝 VLC 的人)
              </p>
              <button
                onClick={() => onBurn(true)}
                className="w-full py-3 font-bold text-white bg-purple-500 hover:bg-purple-600 rounded-lg transition-colors"
              >
                燒進影片(快速,videotoolbox 硬體加速)
              </button>
              <button
                onClick={() => onBurn(false)}
                className="w-full py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                或使用高品質模式(libx264,慢 5-10 倍)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * SRT 寫入時 pipeline 順手寫了同名 .vtt(瀏覽器 <track> 必需)。
 * 這裡只要換副檔名即可。
 */
function srtToVttUrl(srtPath: string): string {
  return srtPath.replace(/\.srt$/, ".vtt");
}

function SummaryPanel({ summary }: { summary: Record<string, unknown> | null }) {
  if (!summary) return null;

  return (
    <div className="space-y-6">
      <p className="text-lg text-gray-600">{summary.one_liner as string}</p>

      <div>
        <h2 className="text-sm font-bold text-orange-500 uppercase tracking-widest mb-3">
          重點摘要
        </h2>
        <div className="space-y-3">
          {(summary.key_points as { label: string; content: string }[])?.map((kp, i) => (
            <div key={i} className="border-l-4 border-orange-400 bg-orange-50 rounded-r-lg p-4">
              <p className="font-bold text-orange-600 text-sm">{kp.label}</p>
              <p className="text-gray-700">{kp.content}</p>
            </div>
          ))}
        </div>
      </div>

      {typeof summary.key_quote === "string" && summary.key_quote && (
        <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-xl p-5">
          <p className="text-3xl text-orange-400 font-black leading-none mb-1">&ldquo;</p>
          <p className="text-gray-700 italic text-lg leading-relaxed">{summary.key_quote}</p>
        </div>
      )}

      {(summary.action_items as string[])?.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-orange-500 uppercase tracking-widest mb-3">
            行動建議
          </h2>
          <div className="space-y-2">
            {(summary.action_items as string[]).map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-5 h-5 mt-0.5 border-2 border-orange-400 rounded flex-shrink-0" />
                <p className="text-gray-700">{item}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {(summary.tags as string[])?.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {(summary.tags as string[]).map((tag) => (
            <span key={tag} className="text-sm px-3 py-1 rounded-full border border-orange-300 text-orange-600">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
