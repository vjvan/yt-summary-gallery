"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import TranscriptView from "@/components/TranscriptView";
import YouTubePlayerWithOverlay from "@/components/YouTubePlayerWithOverlay";
import InteractiveTimeline from "@/components/InteractiveTimeline";
import AnnotationsPanel from "@/components/AnnotationsPanel";
import { useLocalStorage } from "@/lib/use-local-storage";

export default function CardDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [view, setView] = useState<"carousel" | "transcript">("carousel");
  const [loading, setLoading] = useState(true);
  const [initialSeekSec, setInitialSeekSec] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [cardsVersion, setCardsVersion] = useState(0);
  const [downloadingVideo, setDownloadingVideo] = useState(false);
  const [themes, setThemes] = useState<Array<{ id: string; label: string; cardBg: string; accent: string; accentLight: string; accentDark: string }>>([]);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [includeRecall, setIncludeRecall] = useLocalStorage<boolean>("yt_include_recall", false);
  const [featuredSaving, setFeaturedSaving] = useState(false);
  const [regeneratingHighlights, setRegeneratingHighlights] = useState(false);
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const playerSeekRef = useRef<((s: number) => void) | null>(null);
  const burnPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const regenPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dlVideoPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    fetch("/api/themes")
      .then((r) => r.json())
      .then((d) => setThemes(d.themes || []))
      .catch(() => { /* ignore */ });
  }, []);

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

  useEffect(() => {
    return () => {
      if (regenPollRef.current) {
        clearInterval(regenPollRef.current);
        regenPollRef.current = null;
      }
      if (dlVideoPollRef.current) {
        clearInterval(dlVideoPollRef.current);
        dlVideoPollRef.current = null;
      }
    };
  }, []);

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
  const burnedZhUrl = (data.burned_zh_url as string | null) || null;
  const burnedEnUrl = (data.burned_en_url as string | null) || null;
  const burnTrack = (data.burn_track as string | null) || null;
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

  async function handleBurn(hwaccel: boolean, track: "bi" | "zh" | "en") {
    await fetch(`/api/summaries/${id}/burn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hwaccel, track }),
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

  async function handleRegenerateHighlights() {
    if (regeneratingHighlights) return;
    if (!confirm("讓 GPT 重新讀逐字稿產正確的時間軸 (約 10-20 秒)。完成後會刷新頁面。")) return;
    setRegeneratingHighlights(true);
    try {
      const r = await fetch(`/api/summaries/${id}/regenerate-highlights`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(`重產失敗:${err.error || r.statusText}`);
      } else {
        await refresh();
      }
    } finally {
      setRegeneratingHighlights(false);
    }
  }

  async function handleToggleFeatured() {
    if (featuredSaving) return;
    const currentlyFeatured = !!data?.is_featured;
    let note: string | null = null;
    if (!currentlyFeatured) {
      const input = prompt("加進「允雷推薦影片庫」公開頁。輸入推薦理由 (300字內,公開可見):", "");
      if (input === null) return; // 取消
      note = (input || "").trim();
    } else {
      if (!confirm("從推薦頁移除這支影片?")) return;
    }
    setFeaturedSaving(true);
    try {
      await fetch(`/api/summaries/${id}/featured`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          is_featured: !currentlyFeatured,
          featured_note: note || "",
        }),
      });
      await refresh();
    } finally {
      setFeaturedSaving(false);
    }
  }

  async function handleDownloadVideo() {
    if (downloadingVideo) return;
    if (!confirm("會用 yt-dlp 下載這支 YouTube 影片成 mp4 到本機,給原生 player 使用(PiP / 字幕雙語切換 / 播放速度)。1080p 約 300-500MB,完成後磁碟用量請手動管理。")) return;
    setDownloadingVideo(true);
    await fetch(`/api/summaries/${id}/download-video`, { method: "POST" });
    if (dlVideoPollRef.current) clearInterval(dlVideoPollRef.current);
    const startedAt = Date.now();
    dlVideoPollRef.current = setInterval(async () => {
      const d = await refresh();
      const elapsed = Date.now() - startedAt;
      if (d?.video_url || elapsed > 600000) {
        if (dlVideoPollRef.current) {
          clearInterval(dlVideoPollRef.current);
          dlVideoPollRef.current = null;
        }
        setDownloadingVideo(false);
      }
    }, 4000);
  }

  async function handleRegenerateCards(themeId?: string) {
    if (regenerating) return;
    const themeMsg = themeId ? `用「${themes.find((t) => t.id === themeId)?.label || themeId}」配色` : "用目前配色";
    const recallMsg = includeRecall ? " + 自我測驗卡" : "";
    if (!confirm(`${themeMsg}${recallMsg}重畫圖卡 (智能 layout 依影片類型決定張數,首次升級可能 60-90 秒因為要先 GPT 補欄位)。已下載的舊圖卡不受影響。`)) return;
    setRegenerating(true);
    setThemePickerOpen(false);
    const startCount = Number(data?.slide_count || 0);
    const params = new URLSearchParams();
    if (themeId) params.set("theme", themeId);
    if (includeRecall) params.set("include_recall", "true");
    const qs = params.toString();
    const url = qs
      ? `/api/summaries/${id}/regenerate-cards?${qs}`
      : `/api/summaries/${id}/regenerate-cards`;
    await fetch(url, { method: "POST" });
    // Poll slide_count 變動或最多等 90s
    if (regenPollRef.current) clearInterval(regenPollRef.current);
    const startedAt = Date.now();
    regenPollRef.current = setInterval(async () => {
      const d = await refresh();
      const newCount = Number(d?.slide_count || 0);
      const elapsed = Date.now() - startedAt;
      if (newCount !== startCount || elapsed > 180000) {
        if (regenPollRef.current) {
          clearInterval(regenPollRef.current);
          regenPollRef.current = null;
        }
        setRegenerating(false);
        setCardsVersion((v) => v + 1);
        if (newCount > 0 && currentSlide >= newCount) setCurrentSlide(0);
      }
    }, 3000);
  }

  function handleOpenInAivanStudio() {
    const projectUrl = new URL(`/api/summaries/${id}/aivan-project`, window.location.origin);
    if (includeRecall) projectUrl.searchParams.set("recall", "1");

    const studioBase =
      process.env.NEXT_PUBLIC_AIVAN_SLIDE_STUDIO_URL || "http://127.0.0.1:8765/";
    const studioUrl = new URL(studioBase);
    studioUrl.searchParams.set("project", projectUrl.href);
    studioUrl.searchParams.set("view", "gallery");
    studioUrl.searchParams.set("source", "yt-summary");
    window.open(studioUrl.href, "_blank", "noopener,noreferrer");
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

          <div className="flex items-center gap-3">
            {view === "carousel" && (
              <>
                <button
                  onClick={handleToggleFeatured}
                  disabled={featuredSaving}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-bold border transition-colors disabled:opacity-50 ${
                    data?.is_featured
                      ? "border-orange-400 bg-orange-50 text-orange-700"
                      : "border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                  title={data?.is_featured ? "已在推薦頁,點擊移除" : "加進公開的「允雷推薦影片庫」/featured"}
                >
                  <span>{data?.is_featured ? "★ 已推薦" : "☆ 推薦"}</span>
                </button>
                <label
                  className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-bold border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer"
                  title="開啟後重畫圖卡時會多一張「自我測驗」卡 (active recall)。預設關以避免 IG 發佈場景的卡片過多"
                >
                  <input
                    type="checkbox"
                    checked={includeRecall}
                    onChange={(e) => setIncludeRecall(e.target.checked)}
                    className="accent-orange-500"
                  />
                  <span>自我測驗卡</span>
                </label>
                <div className="relative">
                  <button
                    onClick={() => setThemePickerOpen((v) => !v)}
                    disabled={regenerating}
                    className="px-3 py-2 rounded-md text-sm font-bold transition-colors border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    title="換配色 (5 套主題,影片自動分配或手動指定)"
                  >
                    換配色
                    <span className="text-xs">▾</span>
                  </button>
                  {themePickerOpen && themes.length > 0 && (
                    <div className="absolute top-full right-0 mt-1 z-30 bg-white rounded-lg shadow-xl border border-gray-200 p-2 min-w-[200px]">
                      {themes.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => handleRegenerateCards(t.id)}
                          className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-sm hover:bg-gray-50 text-left"
                        >
                          <span className="flex gap-1 flex-shrink-0">
                            <span className="w-4 h-4 rounded-sm border border-gray-200" style={{ background: t.cardBg }} />
                            <span className="w-4 h-4 rounded-sm" style={{ background: t.accent }} />
                            <span className="w-4 h-4 rounded-sm" style={{ background: t.accentLight }} />
                          </span>
                          <span className="font-bold text-gray-700">{t.label}</span>
                          <span className="text-xs text-gray-400 ml-auto">{t.id}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleRegenerateCards()}
                  disabled={regenerating}
                  className="px-3 py-2 rounded-md text-sm font-bold transition-colors border border-orange-200 text-orange-600 hover:bg-orange-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="用目前配色重畫 7 張圖卡(含流程鏈 + 概念地圖)"
                >
                  {regenerating ? "重畫中..." : "重新生成圖卡"}
                </button>
              </>
            )}

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
                  <div className="rounded-xl overflow-hidden shadow-lg bg-white relative">
                    <Image
                      src={cardsVersion > 0 ? `${cardPaths[currentSlide]}?v=${cardsVersion}` : cardPaths[currentSlide]}
                      alt={`Slide ${currentSlide + 1}`}
                      width={1080}
                      height={1350}
                      className="w-full h-auto"
                      unoptimized
                    />
                    {regenerating && (
                      <div className="absolute inset-0 bg-white/70 flex items-center justify-center backdrop-blur-sm">
                        <div className="text-center">
                          <div className="text-orange-500 font-bold text-lg mb-1">圖卡重畫中</div>
                          <div className="text-gray-500 text-sm">套用最新模板(7 張),約 30 秒</div>
                        </div>
                      </div>
                    )}
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
                  <div className="flex flex-wrap gap-3 mt-4">
                    <a
                      href={cardPaths[currentSlide]}
                      download={`slide-${currentSlide + 1}.png`}
                      className="flex-1 py-3 text-center font-bold text-white bg-orange-500 rounded-lg hover:bg-orange-600 transition-colors"
                    >
                      下載此頁
                    </a>
                    <a
                      href={`/api/summaries/${id}/carousel`}
                      download
                      title="全部卡片 PNG (1080x1350 IG 4:5) + 自動生成的貼文文案 caption.txt"
                      className="px-4 py-3 text-center font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors"
                    >
                      Carousel 打包
                    </a>
                    <a
                      href={`/api/summaries/${id}/editor`}
                      target="_blank"
                      rel="noopener"
                      title="開啟可編輯版卡片:點文字直接改、換主題、單張/全部匯出 PNG、下載成獨立 HTML 檔"
                      className="px-4 py-3 text-center font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
                    >
                      快速編輯
                    </a>
                    <button
                      type="button"
                      onClick={handleOpenInAivanStudio}
                      title="把來源、摘要與原卡片視覺一起送進 AIVAN Slide Studio，多頁總覽後逐張編輯"
                      className="px-4 py-3 text-center font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-700 transition-colors"
                    >
                      在 AIVAN Studio 編輯
                    </button>
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
                videoUrl ? (
                  // C 路徑: 已下載 mp4 → 走原生 HTML5 video,有 PiP / 字幕雙語切換 / 速度等原生 UI
                  <div>
                    <VideoPlayerPanel
                      videoUrl={videoUrl}
                      burnedVideoUrl={burnedVideoUrl}
                      burnedZhUrl={burnedZhUrl}
                      burnedEnUrl={burnedEnUrl}
                      burnTrack={burnTrack}
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
                      onTimeUpdate={(t) => setPlayerCurrentTime(t)}
                      onPlayerReady={(api) => { playerSeekRef.current = api.seekTo; }}
                    />
                    {highlights.length > 0 && (
                      <div className="mt-4">
                        <InteractiveTimeline
                          highlights={highlights.map((h) => ({
                            timestamp: h.timestamp,
                            label: h.label,
                            description: h.description,
                          }))}
                          onSeek={(s) => playerSeekRef.current?.(s)}
                          currentTime={playerCurrentTime}
                          durationSec={Number(data?.duration) || 0}
                          onRequestRegenerate={handleRegenerateHighlights}
                        />
                      </div>
                    )}
                    <div className="mt-4">
                      <AnnotationsPanel
                        videoId={data.video_id as string}
                        currentTime={playerCurrentTime}
                        onSeek={(s) => playerSeekRef.current?.(s)}
                      />
                    </div>
                  </div>
                ) : (
                  // A 路徑: iframe + 自製字幕 overlay,零本機磁碟
                  <div className="mb-6">
                    <YouTubePlayerWithOverlay
                      videoId={data.video_id as string}
                      segments={segments}
                      segmentsZh={segmentsZh}
                      isTranslated={isTranslated}
                      initialSeekSec={initialSeekSec}
                      onTimeUpdate={(t) => setPlayerCurrentTime(t)}
                      onPlayerReady={(api) => { playerSeekRef.current = api.seekTo; }}
                    />
                    <div className="mt-3">
                      <button
                        onClick={handleDownloadVideo}
                        disabled={downloadingVideo}
                        className="w-full py-2.5 text-sm font-bold text-orange-600 border-2 border-dashed border-orange-300 rounded-lg hover:bg-orange-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        title="下載成 mp4 後可用瀏覽器原生 PiP / 字幕選單 / 速度控制(約 300-500MB,需數十秒到數分鐘)"
                      >
                        {downloadingVideo ? "下載中(yt-dlp 抓 mp4)..." : "升級成原生 player(下載 mp4 約 300-500MB)"}
                      </button>
                    </div>
                    {highlights.length > 0 && (
                      <div className="mt-4">
                        <InteractiveTimeline
                          highlights={highlights.map((h) => ({
                            timestamp: h.timestamp,
                            label: h.label,
                            description: h.description,
                          }))}
                          onSeek={(s) => playerSeekRef.current?.(s)}
                          currentTime={playerCurrentTime}
                          durationSec={Number(data?.duration) || 0}
                          onRequestRegenerate={handleRegenerateHighlights}
                        />
                      </div>
                    )}
                    <div className="mt-4">
                      <AnnotationsPanel
                        videoId={data.video_id as string}
                        currentTime={playerCurrentTime}
                        onSeek={(s) => playerSeekRef.current?.(s)}
                      />
                    </div>
                  </div>
                )
              ) : isVideo ? (
                <div>
                  <VideoPlayerPanel
                    videoUrl={videoUrl}
                    burnedVideoUrl={burnedVideoUrl}
                    burnedZhUrl={burnedZhUrl}
                    burnedEnUrl={burnedEnUrl}
                    burnTrack={burnTrack}
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
                    onTimeUpdate={(t) => setPlayerCurrentTime(t)}
                    onPlayerReady={(api) => { playerSeekRef.current = api.seekTo; }}
                  />
                  {highlights.length > 0 && (
                    <div className="mt-4">
                      <InteractiveTimeline
                        highlights={highlights.map((h) => ({
                          timestamp: h.timestamp,
                          label: h.label,
                          description: h.description,
                        }))}
                        onSeek={(s) => playerSeekRef.current?.(s)}
                        currentTime={playerCurrentTime}
                        durationSec={Number(data?.duration) || 0}
                        onRequestRegenerate={handleRegenerateHighlights}
                      />
                    </div>
                  )}
                  <div className="mt-4">
                    <AnnotationsPanel
                      videoId={data.video_id as string}
                      currentTime={playerCurrentTime}
                      onSeek={(s) => playerSeekRef.current?.(s)}
                    />
                  </div>
                </div>
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
              {/* Layer 6 護城河:跨 tool 導流 (整合 stack 整套體驗 lock-in) */}
              <div className="mt-6 bg-white rounded-xl border border-gray-200 p-4">
                <h3 className="text-sm font-bold text-gray-700 tracking-wider uppercase mb-3">
                  把這支拿去做別的事
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Link
                    href={`/remix?source=${encodeURIComponent(data.video_id as string)}`}
                    className="flex flex-col gap-1 px-3 py-2.5 rounded-lg border border-gray-200 hover:border-orange-300 hover:bg-orange-50 transition-colors text-left"
                  >
                    <span className="text-sm font-bold text-gray-800">→ 短影片混剪</span>
                    <span className="text-xs text-gray-500">挑 highlights 自動產短片</span>
                  </Link>
                  <Link
                    href={`/clean?source=${encodeURIComponent(data.video_id as string)}`}
                    className="flex flex-col gap-1 px-3 py-2.5 rounded-lg border border-gray-200 hover:border-orange-300 hover:bg-orange-50 transition-colors text-left"
                  >
                    <span className="text-sm font-bold text-gray-800">→ 口播自動剪接</span>
                    <span className="text-xs text-gray-500">剪掉停頓和靜音</span>
                  </Link>
                  <Link
                    href={`/search?q=${encodeURIComponent(((summary?.tags as string[])?.[0] || (summary?.one_liner as string) || "").slice(0, 30))}`}
                    className="flex flex-col gap-1 px-3 py-2.5 rounded-lg border border-gray-200 hover:border-orange-300 hover:bg-orange-50 transition-colors text-left"
                  >
                    <span className="text-sm font-bold text-gray-800">→ 找其他相關影片</span>
                    <span className="text-xs text-gray-500">跨影片庫搜尋這個主題</span>
                  </Link>
                </div>
              </div>
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
type BurnTrackUi = "bi" | "zh" | "en";

function VideoPlayerPanel({
  videoUrl,
  burnedVideoUrl,
  burnedZhUrl,
  burnedEnUrl,
  burnTrack,
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
  onTimeUpdate,
  onPlayerReady,
}: {
  videoUrl: string | null;
  burnedVideoUrl: string | null;
  burnedZhUrl: string | null;
  burnedEnUrl: string | null;
  burnTrack: string | null;
  srtEnPath: string | null;
  srtZhPath: string | null;
  srtBiPath: string | null;
  isTranslated: boolean;
  burnStatus: string | null;
  burnError: string | null;
  fallbackRatio: number;
  initialSeekSec: number | null;
  onBurn: (hwaccel: boolean, track: BurnTrackUi) => void;
  onRetranslate: () => void;
  onTimeUpdate?: (t: number) => void;
  onPlayerReady?: (api: { seekTo: (t: number) => void }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [selTrack, setSelTrack] = useState<BurnTrackUi>("bi");

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

  // 暴露 seekTo + currentTime 給父層做 annotation / interactive timeline
  useEffect(() => {
    onPlayerReady?.({
      seekTo: (s: number) => {
        const v = videoRef.current;
        if (!v) return;
        try {
          v.currentTime = s;
          v.play().catch(() => { /* ignore autoplay block */ });
        } catch { /* ignore */ }
      },
    });
  }, [onPlayerReady]);
  const playSrc = burnedVideoUrl || videoUrl || "";
  const showSoftSubs = !burnedVideoUrl; // 已燒就不掛 track,避免雙重字幕
  const vttBi = srtBiPath ? srtToVttUrl(srtBiPath) : null;
  const vttEn = srtEnPath ? srtToVttUrl(srtEnPath) : null;
  const vttZh = srtZhPath && srtZhPath !== srtBiPath ? srtToVttUrl(srtZhPath) : null;

  const downloads: { href: string; label: string; primary?: boolean }[] = [];
  if (burnedVideoUrl) downloads.push({ href: burnedVideoUrl, label: "下載已燒字幕影片(雙語) mp4", primary: true });
  if (burnedZhUrl) downloads.push({ href: burnedZhUrl, label: "下載已燒字幕影片(中文) mp4", primary: true });
  if (burnedEnUrl) downloads.push({ href: burnedEnUrl, label: "下載已燒字幕影片(英文) mp4", primary: true });
  if (videoUrl) downloads.push({ href: videoUrl, label: "下載原始影片 mp4" });
  if (srtBiPath && isTranslated && srtBiPath !== srtZhPath) downloads.push({ href: srtBiPath, label: "雙語 SRT(VLC/IINA 掛字幕用)" });
  if (srtEnPath && isTranslated) downloads.push({ href: srtEnPath, label: "原文 SRT" });
  if (srtZhPath) downloads.push({ href: srtZhPath, label: isTranslated ? "中譯 SRT" : "字幕 SRT" });

  // 燒錄語系選項。未翻譯的影片只有單一字幕檔,只給一個選項。
  const trackOptions: { key: BurnTrackUi; label: string; burnedUrl: string | null; available: boolean }[] =
    isTranslated
      ? [
          { key: "bi", label: "雙語(上英下中)", burnedUrl: burnedVideoUrl, available: !!srtBiPath },
          { key: "zh", label: "只燒中文", burnedUrl: burnedZhUrl, available: !!srtZhPath },
          { key: "en", label: "只燒英文", burnedUrl: burnedEnUrl, available: !!srtEnPath },
        ]
      : [{ key: "bi", label: "字幕", burnedUrl: burnedVideoUrl, available: !!srtBiPath }];
  const hasUnburned = trackOptions.some((t) => t.available && !t.burnedUrl);
  const selOption = trackOptions.find((t) => t.key === selTrack) || trackOptions[0];
  const burningLabel =
    burnTrack === "zh" ? "中文" : burnTrack === "en" ? "英文" : "雙語";

  return (
    <div className="mb-6">
      <div className="rounded-xl overflow-hidden bg-black mb-3">
        <video
          ref={videoRef}
          src={playSrc}
          controls
          crossOrigin="anonymous"
          className="w-full h-auto"
          onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget.currentTime)}
        >
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
        <p className="text-xs text-center text-gray-400 mb-3">player 播放的是已燒雙語字幕版本</p>
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

      {/* 燒字幕按鈕區: 三種語系獨立燒錄,燒過的顯示 ✓ 並出現在上方下載清單 */}
      {srtBiPath && hasUnburned && (
        <div className="border-t pt-4">
          {burnStatus === "burning" && (
            <div className="text-center py-3 px-4 bg-orange-50 rounded-lg">
              <span className="inline-block w-4 h-4 mr-2 border-2 border-orange-400 border-t-transparent rounded-full animate-spin align-middle" />
              <span className="text-sm text-orange-700 font-bold">
                {burningLabel}字幕燒錄中(背景進行,可關閉頁面)
              </span>
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
              {trackOptions.length > 1 && (
                <div className="flex gap-2 justify-center mb-2">
                  {trackOptions.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setSelTrack(t.key)}
                      disabled={!t.available}
                      className={`px-4 py-2 rounded-lg text-sm font-bold border-2 transition-colors ${
                        selTrack === t.key
                          ? "border-purple-500 bg-purple-50 text-purple-700"
                          : "border-gray-200 text-gray-500 hover:border-gray-300"
                      } ${!t.available ? "opacity-40 cursor-not-allowed" : ""}`}
                    >
                      {t.label}
                      {t.burnedUrl ? " ✓" : ""}
                    </button>
                  ))}
                </div>
              )}
              {selOption.burnedUrl ? (
                <p className="text-sm text-center text-green-600 py-2">
                  此語系已燒錄完成,上方可下載
                </p>
              ) : (
                <>
                  <button
                    onClick={() => onBurn(true, selOption.key)}
                    className="w-full py-3 font-bold text-white bg-purple-500 hover:bg-purple-600 rounded-lg transition-colors"
                  >
                    燒進影片(快速,videotoolbox 硬體加速)
                  </button>
                  <button
                    onClick={() => onBurn(false, selOption.key)}
                    className="w-full py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
                  >
                    或使用高品質模式(libx264,慢 5-10 倍)
                  </button>
                </>
              )}
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

      {(summary.action_items as Array<unknown>)?.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-orange-500 uppercase tracking-widest mb-3">
            立即動手
          </h2>
          <div className="space-y-2">
            {(summary.action_items as Array<unknown>).map((raw, i) => {
              // 兼容兩種 shape: 舊版 string / 新版 {action, expected_outcome, time_estimate}
              const item =
                typeof raw === "string"
                  ? { action: raw, expected_outcome: "", time_estimate: "" }
                  : (raw as { action?: string; expected_outcome?: string; time_estimate?: string });
              const meta: string[] = [];
              if (item.time_estimate) meta.push(`⏱ ${item.time_estimate}`);
              if (item.expected_outcome) meta.push(`→ ${item.expected_outcome}`);
              return (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 mt-0.5 border-2 border-orange-400 rounded flex-shrink-0" />
                  <div>
                    <p className="text-gray-700">{item.action || ""}</p>
                    {meta.length > 0 && (
                      <p className="text-xs text-gray-500 mt-0.5">{meta.join("　·　")}</p>
                    )}
                  </div>
                </div>
              );
            })}
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
