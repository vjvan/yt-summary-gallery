"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import TranscriptView from "@/components/TranscriptView";
import YouTubePlayerWithOverlay from "@/components/YouTubePlayerWithOverlay";
import InteractiveTimeline from "@/components/InteractiveTimeline";
import AnnotationsPanel from "@/components/AnnotationsPanel";
import { canBurnSubtitleTrack, mediaFailureMessage, mediaResponse, pollMediaTask } from "@/lib/media-export-client";
import { segmentsToSrt } from "@/lib/pipeline/generate-srt";
import AttachOriginalVideo from "@/components/AttachOriginalVideo";
import CardStylePanel from "@/components/CardStylePanel";
import LearningAnalysisPanel from "@/components/LearningAnalysisPanel";
import { BACKGROUNDS, CARD_THEMES, FONT_PRESETS, resolveCardStyle, type CardStyle } from "@/lib/card-style";

export default function CardDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [view, setView] = useState<"carousel" | "transcript" | "learning">("carousel");
  const [loading, setLoading] = useState(true);
  const [initialSeekSec, setInitialSeekSec] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [cardsVersion, setCardsVersion] = useState(0);
  const [downloadingVideo, setDownloadingVideo] = useState(false);
  const [burnSubmitting, setBurnSubmitting] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const [mediaNotice, setMediaNotice] = useState("");
  const [subtitleRetrying, setSubtitleRetrying] = useState(false);
  const [subtitleActionError, setSubtitleActionError] = useState("");
  const subtitleRetryRef = useRef<AbortController | null>(null);
  const subtitleResumeUntil = useRef(0);
  const mediaActionRef = useRef<AbortController | null>(null);
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [styleError, setStyleError] = useState("");
  const [styleNotice, setStyleNotice] = useState("");
  const [featuredSaving, setFeaturedSaving] = useState(false);
  const [regeneratingHighlights, setRegeneratingHighlights] = useState(false);
  const [openingAivanStudio, setOpeningAivanStudio] = useState(false);
  const [learningVisited, setLearningVisited] = useState(false);
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const playerSeekRef = useRef<((s: number) => void) | null>(null);
  const burnPollRef = useRef<AbortController | null>(null);
  const regenPollRef = useRef<AbortController | null>(null);

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

  const pipelineStatus = data?.status;
  const subtitleStatus = typeof data?.subtitle_status === "string" ? data.subtitle_status : null;
  // Subtitle work also updates pipeline_stage; a claimed card-render token is
  // independent and remains authoritative until that exact render settles.
  const renderingCards = data?.card_render_token != null || data?.pipeline_stage === "library_rendering";
  useEffect(() => {
    if (pipelineStatus !== "processing" && subtitleStatus !== "processing" && !renderingCards) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 3_600_000;
    const poll = async () => {
      try {
        const response = await fetch(`/api/summaries/${encodeURIComponent(id)}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error("無法取得字幕進度，請重新整理確認；不會自動重送模型請求。");
        const next = await response.json();
        if (controller.signal.aborted) return;
        // A just-acknowledged resume can briefly race a stale GET. Keep bounded
        // polling instead of restoring the old partial state and silently stopping.
        if (subtitleResumeUntil.current > Date.now() && (next.subtitle_status === "partial" || next.subtitle_status === "error")) {
          timer = setTimeout(poll, 1000);
          return;
        }
        subtitleResumeUntil.current = 0;
        setData(next);
        if (next.status === "processing" || next.subtitle_status === "processing" || next.card_render_token != null || next.pipeline_stage === "library_rendering") {
          if (Date.now() >= deadline) setSubtitleActionError("進度查詢已達一小時，請重新整理確認；後端可能仍在處理。");
          else timer = setTimeout(poll, 4000);
        }
      } catch (error) {
        if (!controller.signal.aborted) setSubtitleActionError(error instanceof Error ? error.message : "字幕進度查詢失敗，請重新整理確認。");
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, pipelineStatus, subtitleStatus, renderingCards]);

  // One bounded poll at a time. Unmount cancels UI polling, not a running FFmpeg task.
  const currentBurnStatus = data?.burn_status;
  useEffect(() => {
    if (currentBurnStatus !== "burning") return;
    const controller = new AbortController();
    burnPollRef.current = controller;
    void pollMediaTask({
      action: "burn", signal: controller.signal,
      read: async () => mediaResponse(await fetch(`/api/summaries/${encodeURIComponent(id)}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      }), "burn"),
      onUpdate: (next) => {
        if (controller.signal.aborted) return;
        setData(next);
        if (next.burn_status === "error") setMediaNotice("");
        if (next.burn_status === "done") setMediaNotice("字幕燒錄完成，現在可下載已燒字幕影片。");
      },
    }).then(() => { if (!controller.signal.aborted) setMediaNotice("字幕燒錄完成，現在可下載已燒字幕影片。"); })
      .catch((error) => { if (!controller.signal.aborted) setMediaError(error instanceof Error ? error.message : "無法查詢燒錄狀態。"); });
    return () => { controller.abort(); if (burnPollRef.current === controller) burnPollRef.current = null; };
  }, [currentBurnStatus, id]);

  useEffect(() => {
    return () => {
      regenPollRef.current?.abort();
      regenPollRef.current = null;
      mediaActionRef.current?.abort();
      mediaActionRef.current = null;
      subtitleRetryRef.current?.abort();
      subtitleRetryRef.current = null;
      subtitleResumeUntil.current = 0;
    };
  }, [id]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-400">載入中...</p>
      </main>
    );
  }

  // A saved row may have an independent download/subtitle error; do not erase its summary.
  if (!data || !data.id) {
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

  const activeStyle = resolveCardStyle(data.card_style as string | Partial<CardStyle> | null | undefined);
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
  const subtitleFilesComplete = subtitleStatus == null || subtitleStatus === "complete";

  function handleDownloadOriginalSrt() {
    setMediaError("");
    if (!segments.length) return;
    try {
      // The legacy SRT API prefers Chinese. Export the actual loaded source,
      // never label its default response as original or invent a missing path.
      const blob = new Blob([segmentsToSrt(segments)], { type: "application/x-subrip;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      try {
        anchor.href = objectUrl;
        anchor.download = `${String(data?.video_id || id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "subtitle"}.original.srt`;
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        // Leave enough time for the browser to consume the clicked download.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      }
    } catch {
      setMediaError("原文字幕時間或文字無效，無法匯出；請重新載入資料後確認。");
    }
  }

  // Same text is a review hint only; protected names can legitimately remain English.
  let fallbackRatio = 0;
  if (isTranslated && segmentsZh && segments.length > 0 && segments.length === segmentsZh.length) {
    let fallback = 0;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].text.trim() === segmentsZh[i].text.trim()) fallback++;
    }
    fallbackRatio = fallback / segments.length;
  }

  async function handleContinueSubtitles() {
    if (subtitleRetryRef.current || subtitleRetrying || !data?.url) return;
    if (!confirm("在本機繼續完成字幕，已完成且匹配的驗證快取不重算。會使用 CPU／GPU 與電力；若伺服器已改為雲端，此本機工作會拒絕續作，不會自動改走付費服務。要繼續嗎？")) return;
    const controller = new AbortController();
    subtitleRetryRef.current = controller;
    setSubtitleRetrying(true); setSubtitleActionError("");
    try {
      const response = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: data.url }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "無法續作字幕，請檢查本機處理模式。");
      if (!controller.signal.aborted) {
        if (result.subtitle_status === "processing") {
          subtitleResumeUntil.current = Date.now() + 15_000;
          setData(previous => previous ? { ...previous, subtitle_status: "processing" } : previous);
        } else await refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) setSubtitleActionError(error instanceof Error ? error.message : "字幕續作失敗，請稍後手動重試。");
    } finally {
      if (subtitleRetryRef.current === controller) { subtitleRetryRef.current = null; setSubtitleRetrying(false); }
    }
  }

  async function handleBurn(hwaccel: boolean, track: "bi" | "zh" | "en") {
    if (mediaActionRef.current || burnSubmitting || burnStatus === "burning") return;
    if (!confirm("確認你有權處理此影片及字幕。將使用本機 FFmpeg 產生額外的已燒字幕 MP4，耗用磁碟、CPU／GPU；不會呼叫翻譯模型。要開始嗎？")) return;
    const controller = new AbortController();
    mediaActionRef.current = controller;
    setBurnSubmitting(true); setMediaError(""); setMediaNotice("正在確認原片與字幕…");
    try {
      const result = await mediaResponse(await fetch(`/api/summaries/${encodeURIComponent(id)}/burn`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hwaccel, track }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      }), "burn");
      if (controller.signal.aborted) return;
      setMediaNotice(result.status === "done" ? "此語系已燒錄完成，可由下方下載。" : "已開始本機燒錄；可關閉頁面，但本機服務需保持開啟。");
      await refresh();
    } catch (error) {
      if (!controller.signal.aborted) { setMediaNotice(""); setMediaError(error instanceof Error ? error.message : "無法開始燒錄。"); }
    } finally {
      if (mediaActionRef.current === controller) { mediaActionRef.current = null; setBurnSubmitting(false); }
    }
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
    if (mediaActionRef.current || downloadingVideo) return;
    if (!confirm("確認你有權下載與處理此影片。將使用 yt-dlp 把原片存到本機，之後才能燒字幕及下載 MP4；檔案可能數百 MB 或更大，請確認磁碟空間。來源若拒絕存取不會繞過限制。要下載嗎？")) return;
    const controller = new AbortController();
    mediaActionRef.current = controller;
    setDownloadingVideo(true); setMediaError(""); setMediaNotice("正在下載已授權原片，完成後可選擇燒錄字幕…");
    try {
      await mediaResponse(await fetch(`/api/summaries/${encodeURIComponent(id)}/download-video`, {
        method: "POST", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      }), "download");
      await pollMediaTask({
        action: "download", signal: controller.signal,
        read: async () => mediaResponse(await fetch(`/api/summaries/${encodeURIComponent(id)}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        }), "download"),
        onUpdate: (next) => { if (!controller.signal.aborted) setData(next); },
      });
      if (!controller.signal.aborted) setMediaNotice("原片已就緒；下方可選擇字幕語系，手動燒錄後下載 MP4。");
    } catch (error) {
      if (!controller.signal.aborted) { setMediaNotice(""); setMediaError(error instanceof Error ? error.message : "下載失敗，請稍後手動重試。"); }
    } finally {
      if (mediaActionRef.current === controller) { mediaActionRef.current = null; setDownloadingVideo(false); }
    }
  }

  async function handleRegenerateCards(style: CardStyle) {
    if (regenPollRef.current || regenerating || renderingCards) throw new Error("圖卡已在重畫中，請等待完成。");
    const controller = new AbortController();
    const previousCardPaths = JSON.stringify(cardPaths);
    regenPollRef.current = controller;
    setRegenerating(true); setStyleError(""); setStyleNotice("");
    const request = async (url: string, method = "GET") => {
      const response = await fetch(url, {
        method, cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "無法查詢圖卡重畫狀態，請稍後重新整理確認。");
      return result;
    };
    const wait = () => new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted) { reject(new Error("進度查詢已停止。")); return; }
      const abort = () => { clearTimeout(timer); reject(new Error("進度查詢已停止。")); };
      const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 1500);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const query = new URLSearchParams({ palette: style.palette, font: style.fontPreset, bg: style.background });
      const acknowledged = await request(`/api/summaries/${encodeURIComponent(id)}/regenerate-cards?${query}`, "POST");
      if (controller.signal.aborted) return;
      const renderToken = typeof acknowledged.render_token === "string" ? acknowledged.render_token : null;
      if (!renderToken) throw new Error("後端未回傳可驗證的圖卡工作編號。請重新整理確認處理狀態；不會自動重送。");
      // Keep card_style and all old image URLs until the backend commits success.
      setData(previous => previous ? { ...previous, pipeline_stage: "library_rendering",
        ...(renderToken ? { card_render_token: renderToken } : {}) } : previous);
      const deadline = Date.now() + 180_000;
      while (!controller.signal.aborted) {
        await wait();
        const next = await request(`/api/summaries/${encodeURIComponent(id)}`);
        if (controller.signal.aborted) return;
        setData(next);
        const stillClaimed = next.card_render_token != null;
        if (!stillClaimed && (next.pipeline_stage === "library_render_error"
          || (typeof next.error === "string" && next.error.includes("library_render_error")))) {
          throw new Error("重畫失敗，原有圖卡與樣式仍保留。請稍後手動重試。");
        }
        if (!stillClaimed) {
          const saved = resolveCardStyle(next.card_style);
          // Never infer completion from the shared stage or unchanged old PNGs.
          // Rendering publishes immutable per-job paths and style atomically.
          const committed = saved.palette === style.palette && saved.fontPreset === style.fontPreset && saved.background === style.background
            && Array.isArray(next.card_paths) && next.card_paths.length === 20
            && JSON.stringify(next.card_paths) !== previousCardPaths
            && next.card_paths.every((file: unknown) => typeof file === "string" && file.includes(`/style-${renderToken}/`));
          if (committed) {
            setCardsVersion(Date.now());
            if (currentSlide >= next.card_paths.length) setCurrentSlide(0);
            setStyleNotice("已套用樣式，完整 20 張圖卡重畫完成。");
            setStylePanelOpen(false);
            return;
          }
        }
        if (Date.now() >= deadline) throw new Error("進度查詢已達 3 分鐘。後端可能仍在重畫，請重新整理確認；不會自動重送。");
      }
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      if (regenPollRef.current === controller) { regenPollRef.current = null; setRegenerating(false); }
    }
  }

  async function handleOpenInAivanStudio() {
    if (openingAivanStudio) return;
    setOpeningAivanStudio(true);
    const studioWindow = window.open("about:blank", "_blank");

    try {
      const linkUrl = new URL(`/api/summaries/${id}/aivan-cloud-link`, window.location.origin);
      const linkResponse = await fetch(linkUrl, { cache: "no-store" });
      const link = await linkResponse.json().catch(() => ({}));
      if (!linkResponse.ok || !link.projectUrl) {
        throw new Error(link.error || `雲端 Project JSON 同步失敗：HTTP ${linkResponse.status}`);
      }

      const studioBase =
        process.env.NEXT_PUBLIC_AIVAN_SLIDE_STUDIO_URL || "http://127.0.0.1:8765/";
      const studioUrl = new URL(studioBase);
      studioUrl.searchParams.set("project", link.projectUrl);
      studioUrl.searchParams.set("view", "gallery");
      studioUrl.searchParams.set("source", "yt-summary-cloud");

      if (studioWindow) {
        studioWindow.opener = null;
        studioWindow.location.replace(studioUrl.href);
      } else {
        window.open(studioUrl.href, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      studioWindow?.close();
      alert(error instanceof Error ? error.message : "無法開啟 AIVAN Studio");
    } finally {
      setOpeningAivanStudio(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className={view === "transcript" ? "max-w-[1600px] mx-auto px-6 py-6" : "max-w-7xl mx-auto px-4 py-8"}>
        {typeof data.error === "string" && data.error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{data.error.startsWith("download-video:") ? mediaFailureMessage(data.error, "download") : "此筆先前工作發生錯誤；已有摘要、原文及字幕仍保留，可檢查處理狀態後續作。"}</p>}
        {(subtitleStatus || data.status === "processing" || renderingCards) && (
          <section aria-label="字幕處理進度" className="mb-5 rounded-xl border border-orange-200 bg-orange-50 p-4">
            <p className="font-bold text-gray-900">{summary ? "摘要已可閱讀" : "摘要處理中"} · {subtitleStatus === "complete" ? "字幕已完整匯出" : subtitleStatus === "processing" ? "本機字幕處理中" : subtitleStatus === "partial" ? "字幕部分完成" : subtitleStatus === "error" ? "字幕處理失敗" : "等待原文與字幕"}</p>
            {renderingCards && <p role="status" className="mt-1 text-sm font-bold text-orange-800">摘要圖卡產生中，完成後會自動更新；已完成的字幕會保留。</p>}
            {subtitleStatus && <p role="status" className="mt-1 text-sm text-gray-700">已完成 {Number(data.subtitle_completed) || 0}／{Number(data.subtitle_total) || 0} 句。{subtitleStatus !== "complete" && "未完成時不提供完整中文／雙語 SRT 或燒錄；摘要仍可閱讀，已有原文字幕可使用。"}</p>}
            {typeof data.subtitle_error === "string" && data.subtitle_error && <p className="mt-2 text-sm text-red-700">{data.subtitle_error}</p>}
            {subtitleActionError && <p role="alert" className="mt-2 text-sm text-red-700">{subtitleActionError}</p>}
            {(subtitleStatus === "partial" || subtitleStatus === "error") && <button type="button" onClick={handleContinueSubtitles} disabled={subtitleRetrying} className="mt-3 rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{subtitleRetrying ? "正在續作字幕…" : "在本機繼續完成字幕"}</button>}
            <p className="mt-2 text-xs text-gray-600">字幕與摘要分開完成；字幕處理仍會使用本機算力。顯示全部句數不等於已通過人工語意審校。</p>
          </section>
        )}
        {/* Header row */}
        <div className="mb-4 flex flex-col items-start gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Link
            href="/"
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            &larr; 回到 Gallery
          </Link>

          <div className="flex max-w-full flex-wrap items-center gap-2">
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
                <button type="button"
                  onClick={() => { setStyleError(""); setStyleNotice(""); setStylePanelOpen(true); }}
                  disabled={regenerating || renderingCards}
                  aria-haspopup="dialog" aria-expanded={stylePanelOpen}
                  className="min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2 text-base font-bold text-stone-800 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                  title="分別選擇配色、字型與背景，先預覽再套用">樣式</button>
                <button type="button"
                  onClick={() => {
                    if (confirm("以目前已套用的樣式重畫完整 20 張。只重畫既有內容，不翻譯或呼叫模型。要開始嗎？")) {
                      void handleRegenerateCards(activeStyle).catch(error => setStyleError(error instanceof Error ? error.message : "重畫未完成，原有圖卡仍保留。"));
                    }
                  }}
                  disabled={regenerating || renderingCards}
                  className="min-h-11 rounded-lg border border-orange-200 px-3 py-2 text-sm font-bold text-orange-700 transition-colors hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title="使用已儲存的配色、字型與背景重畫 20 張">
                  {regenerating ? "重畫中…" : "重新生成圖卡"}
                </button>
              </>
            )}

            {/* View toggle */}
            <div className="flex max-w-full flex-wrap gap-1 bg-gray-100 rounded-lg p-1" role="group" aria-label="影片閱讀方式">
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
              <button type="button" onClick={() => { setLearningVisited(true); setView("learning"); }} aria-pressed={view === "learning"}
                className={`min-h-11 rounded-md px-4 py-2 text-sm font-bold transition-colors ${view === "learning" ? "bg-white text-orange-700 shadow-sm" : "text-gray-600 hover:text-gray-800"}`}>
                證據學習
              </button>
            </div>
          </div>
        </div>

        {/* Title */}
        <div className="mb-6">
          <h1 className="text-2xl font-black text-gray-900 mb-1">
            {(summary?.title_display as string) || (data.title as string)}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
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
          <div aria-label="已套用的圖卡樣式" className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-sm text-stone-600">已套用</span>
            <span data-style-axis="palette" className="inline-flex min-h-8 items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1 text-sm font-medium text-stone-700"><span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ background: CARD_THEMES[activeStyle.palette].accent }} />配色 · {CARD_THEMES[activeStyle.palette].label}</span>
            <span data-style-axis="font" className="rounded-full border border-stone-200 bg-white px-3 py-1 text-sm font-medium text-stone-700">字型 · {FONT_PRESETS[activeStyle.fontPreset].label}</span>
            <span data-style-axis="background" className="rounded-full border border-stone-200 bg-white px-3 py-1 text-sm font-medium text-stone-700">背景 · {BACKGROUNDS[activeStyle.background].label}</span>
          </div>
          {styleError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-base leading-7 text-red-800">{styleError}</p>}
          {styleNotice && <p role="status" className="mt-3 text-base leading-7 text-emerald-800">{styleNotice}</p>}
        </div>

        {stylePanelOpen && <CardStylePanel key={id} id={id} activeStyle={activeStyle} onCancel={() => setStylePanelOpen(false)} onApply={handleRegenerateCards} />}

        {learningVisited && <div hidden={view !== "learning"}><LearningAnalysisPanel key={id} id={id} onSeek={(seconds) => {
          setInitialSeekSec(seconds);
          // The Carousel player consumes initialSeekSec; TranscriptView does not.
          // Mount the real target player rather than calling a stale, unmounted ref.
          setView("carousel");
        }} /></div>}

        {/* === CAROUSEL VIEW === */}
        {view === "carousel" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div>
              {cardPaths.length > 0 && (
                <>
                  <div className="rounded-xl overflow-hidden shadow-lg bg-white relative">
                    <Image
                      src={cardsVersion > 0 ? `${cardPaths[currentSlide]}${cardPaths[currentSlide].includes("?") ? "&" : "?"}v=${cardsVersion}` : cardPaths[currentSlide]}
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
                          <div className="text-gray-500 text-sm">套用所選樣式至完整 20 張，請稍候</div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="mt-4 grid grid-cols-[auto_1fr_auto] items-center gap-4">
                    <button
                      onClick={() => setCurrentSlide(Math.max(0, currentSlide - 1))}
                      disabled={currentSlide === 0}
                      className="px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed font-bold"
                    >
                      &larr;
                    </button>
                    <div className="min-w-0 text-center">
                      <div className="mb-2 font-mono text-sm font-bold text-gray-700">
                        {String(currentSlide + 1).padStart(2, "0")} / {String(cardPaths.length).padStart(2, "0")}
                      </div>
                      <div className="mx-auto grid max-w-[260px] grid-cols-10 gap-1.5">
                        {cardPaths.map((_, i) => (
                          <button
                            key={i}
                            onClick={() => setCurrentSlide(i)}
                            aria-label={`前往第 ${i + 1} 頁`}
                            aria-current={i === currentSlide ? "page" : undefined}
                            className={`h-1.5 rounded-full transition-colors ${
                              i === currentSlide
                                ? "bg-orange-500"
                                : "bg-gray-300 hover:bg-gray-400"
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => setCurrentSlide(Math.min(cardPaths.length - 1, currentSlide + 1))}
                      disabled={currentSlide === cardPaths.length - 1}
                      className="px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed font-bold"
                    >
                      &rarr;
                    </button>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-gray-500">
                    共 20 頁、1080 × 1350（4:5）。可直接用 Instagram App 發佈；部分第三方排程工具或 API 仍可能只接受 10 頁。
                  </p>
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
                      disabled={openingAivanStudio}
                      title="先把 Project JSON 安全同步到雲端，再送進 AIVAN Slide Studio 編輯"
                      className="px-4 py-3 text-center font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-700 transition-colors disabled:opacity-50"
                    >
                      {openingAivanStudio ? "正在同步雲端……" : "在 AIVAN Studio 編輯"}
                    </button>
                    {segments.length > 0 && !(source === "youtube" && !videoUrl) && (
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
                      subtitleStatus={subtitleStatus}
                      srtEnPath={srtEnPath}
                      srtZhPath={srtZhPath}
                      srtBiPath={srtBiPath}
                      isTranslated={isTranslated}
                      burnStatus={burnStatus}
                      burnError={burnError}
                      requestError={mediaError}
                      requestNotice={mediaNotice}
                      burnSubmitting={burnSubmitting}
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
                    {(srtEnPath || segments.length > 0 || (subtitleFilesComplete && (srtZhPath || srtBiPath))) && (
                      <section aria-label="字幕檔下載" className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
                        <p className="mb-2 text-sm font-bold text-gray-700">字幕檔下載（不需下載原片）</p>
                        <div className="flex flex-wrap gap-2">
                          {srtEnPath ? (
                            <a href={srtEnPath} download className="rounded-md bg-gray-100 px-3 py-2 text-sm font-bold text-gray-700 hover:bg-gray-200">原文 SRT</a>
                          ) : segments.length > 0 && (
                            <button type="button" onClick={handleDownloadOriginalSrt} className="rounded-md bg-gray-100 px-3 py-2 text-sm font-bold text-gray-700 hover:bg-gray-200">原文 SRT</button>
                          )}
                          {subtitleFilesComplete && srtZhPath && (
                            <a href={srtZhPath} download className="rounded-md bg-blue-50 px-3 py-2 text-sm font-bold text-blue-700 hover:bg-blue-100">{isTranslated ? "中譯 SRT" : "字幕 SRT"}</a>
                          )}
                          {subtitleFilesComplete && isTranslated && srtBiPath && srtBiPath !== srtZhPath && (
                            <a href={srtBiPath} download className="rounded-md bg-purple-50 px-3 py-2 text-sm font-bold text-purple-700 hover:bg-purple-100">雙語 SRT</a>
                          )}
                        </div>
                        {!subtitleFilesComplete && <p className="mt-2 text-xs text-gray-600">中譯尚未全部完成，目前只提供原文；完成後才提供中譯／雙語 SRT。</p>}
                      </section>
                    )}
                    <div className="mt-3">
                      <p className="mb-2 text-sm text-gray-600">庫內已可觀看字幕。要下載「字幕直接顯示在畫面內」的 MP4，須先取得有權使用的原片，再手動燒錄。</p>
                      {mediaError && <p role="alert" className="mb-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">{mediaError}</p>}
                      {mediaNotice && <p role="status" className="mb-2 text-sm text-gray-600">{mediaNotice}</p>}
                      <button
                        onClick={handleDownloadVideo}
                        disabled={downloadingVideo}
                        className="w-full py-2.5 text-sm font-bold text-orange-600 border-2 border-dashed border-orange-300 rounded-lg hover:bg-orange-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        title="需有下載授權及足夠磁碟空間；來源拒絕時不繞過限制"
                      >
                        {downloadingVideo ? "原片下載中…" : "下載已授權原片，準備燒字幕 MP4"}
                      </button>
                    </div>
                    <AttachOriginalVideo key={id} id={id} duration={Number(data.duration) || 0}
                      busy={downloadingVideo || burnSubmitting || burnStatus === "burning"}
                      onAttached={async () => { setMediaError(""); setMediaNotice("原片已附加；請先播放確認時間軸，再手動燒錄字幕。"); await refresh(); }} />
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
                    subtitleStatus={subtitleStatus}
                    srtEnPath={srtEnPath}
                    srtZhPath={srtZhPath}
                    srtBiPath={srtBiPath}
                    isTranslated={isTranslated}
                    burnStatus={burnStatus}
                    burnError={burnError}
                    requestError={mediaError}
                    requestNotice={mediaNotice}
                    burnSubmitting={burnSubmitting}
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
  subtitleStatus,
  srtEnPath,
  srtZhPath,
  srtBiPath,
  isTranslated,
  burnStatus,
  burnError,
  requestError,
  requestNotice,
  burnSubmitting,
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
  subtitleStatus: string | null;
  srtEnPath: string | null;
  srtZhPath: string | null;
  srtBiPath: string | null;
  isTranslated: boolean;
  burnStatus: string | null;
  burnError: string | null;
  requestError: string;
  requestNotice: string;
  burnSubmitting: boolean;
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
  if (srtEnPath) downloads.push({ href: srtEnPath, label: "原文 SRT" });
  if (srtZhPath) downloads.push({ href: srtZhPath, label: isTranslated ? "中譯 SRT" : "字幕 SRT" });

  // 燒錄語系選項。未翻譯的影片只有單一字幕檔,只給一個選項。
  const trackOptions: { key: BurnTrackUi; label: string; burnedUrl: string | null; available: boolean }[] =
    isTranslated
      ? [
          { key: "bi", label: "雙語(上中下英)", burnedUrl: burnedVideoUrl, available: !!srtBiPath && canBurnSubtitleTrack(subtitleStatus, "bi") },
          { key: "zh", label: "只燒中文", burnedUrl: burnedZhUrl, available: !!srtZhPath && canBurnSubtitleTrack(subtitleStatus, "zh") },
          { key: "en", label: "只燒英文", burnedUrl: burnedEnUrl, available: !!srtEnPath },
        ]
      : subtitleStatus && subtitleStatus !== "complete"
        ? [{ key: "en", label: "原文字幕", burnedUrl: burnedEnUrl, available: !!srtEnPath }]
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
            抽查提醒：約 {(fallbackRatio * 100).toFixed(0)}% 段的原文與譯文相同
          </p>
          <p className="text-xs text-amber-700 mb-3">
            品牌、版本與技術名稱可能合法保留英文；字串相同不等於漏譯。請比對完整原文，確認一般敘述是否有翻譯。
          </p>
          {subtitleStatus == null && <button
            onClick={onRetranslate}
            className="w-full py-2.5 font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors text-sm"
          >
            使用原有流程重新翻譯（可能有模型費用）
          </button>}
        </div>
      )}
      {isTranslated && fallbackRatio === 0 && (
        <p className="text-xs text-center text-green-600 mb-3">已載入譯文；仍建議抽查術語、數字與語意。</p>
      )}

      {requestError && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{requestError}</p>}
      {requestNotice && <p role="status" className="mb-3 text-sm text-gray-600">{requestNotice}</p>}
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
      {hasUnburned && (
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
              <p className="text-xs text-red-500 mt-1">{mediaFailureMessage(burnError, "burn")}</p>
            </div>
          )}
          {burnStatus !== "burning" && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 text-center mb-2">
                本次燒錄：{selOption.label}。把字幕直接顯示在輸出 MP4 畫面內。
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
                    disabled={burnSubmitting}
                    className="w-full py-3 font-bold text-white bg-purple-500 hover:bg-purple-600 rounded-lg transition-colors"
                  >
                    {burnSubmitting ? "正在啟動燒錄…" : "燒進影片（快速，videotoolbox 硬體加速）"}
                  </button>
                  <button
                    onClick={() => onBurn(false, selOption.key)}
                    disabled={burnSubmitting}
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
