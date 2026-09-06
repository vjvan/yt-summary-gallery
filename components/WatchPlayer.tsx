"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { enterCaptionFullscreen } from "@/lib/watch/player-fullscreen";
import { selectCaptionPage, splitCaptionPages } from "@/lib/watch/caption-pages";

export interface WatchPlayerApi {
  seekTo: (seconds: number) => void;
  pause: () => void;
}

interface YouTubePlayer {
  getCurrentTime: () => number;
  getPlayerState: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  pauseVideo: () => void;
  destroy: () => void;
}
interface YouTubeApi {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: () => void;
        onStateChange: (event: { data: number }) => void;
        onError: (event: { data: number }) => void;
      };
    },
  ) => YouTubePlayer;
}

type YouTubeWindow = Window & {
  YT?: YouTubeApi;
  onYouTubeIframeAPIReady?: () => void;
};
let apiPromise: Promise<YouTubeApi> | null = null;

/** 官方 IFrame Player API；不接收任意來源的 postMessage。 */
function loadYouTubeApi(): Promise<YouTubeApi> {
  const youtubeWindow = window as YouTubeWindow;
  if (youtubeWindow.YT?.Player) return Promise.resolve(youtubeWindow.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previousCallback = youtubeWindow.onYouTubeIframeAPIReady;
    const timeout = window.setTimeout(() => {
      apiPromise = null;
      reject(new Error("YouTube 播放器載入逾時，請重新載入頁面。"));
    }, 20000);
    youtubeWindow.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      if (youtubeWindow.YT?.Player) resolve(youtubeWindow.YT);
      else reject(new Error("YouTube 播放器尚未就緒。"));
      previousCallback?.();
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeout);
        apiPromise = null;
        reject(new Error("無法載入 YouTube 播放器，請檢查網路或內容阻擋設定。"));
      };
      document.head.appendChild(script);
    }
  });
  return apiPromise;
}

interface Props {
  videoId: string;
  demo: boolean;
  time: number;
  playing: boolean;
  original: string;
  translated: string;
  cueStart?: number;
  cueEnd?: number;
  captionMode: "bilingual" | "translated" | "original" | "off";
  captionStatus: string;
  onTime: (time: number) => void;
  onPlaying: (playing: boolean) => void;
  onReady: (api: WatchPlayerApi | null) => void;
}

export default function WatchPlayer(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [pageExpanded, setPageExpanded] = useState(false);
  const [fullscreenNotice, setFullscreenNotice] = useState("");
  const expanded = nativeFullscreen || pageExpanded;
  const callbacksRef = useRef(props);
  const [playerError, setPlayerError] = useState("");
  const [playerWidth, setPlayerWidth] = useState(360);
  const pausePlayback = useRef<(() => void) | null>(null);
  const [fullCaption, setFullCaption] = useState<{ original: string; translated: string; start?: number } | null>(null);
  useEffect(() => { callbacksRef.current = props; }, [props]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const measure = () => setPlayerWidth(wrapper.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const changed = () => setNativeFullscreen(document.fullscreenElement === wrapper);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      if (wrapper && document.fullscreenElement === wrapper) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!pageExpanded) return;
    const previousOverflow = document.body.style.overflow;
    const expandButton = expandButtonRef.current;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPageExpanded(false); };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", escape);
      expandButton?.focus({ preventScroll: true });
    };
  }, [pageExpanded]);

  useEffect(() => { if (expanded) closeButtonRef.current?.focus({ preventScroll: true }); }, [expanded]);

  const expand = async () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    setFullscreenNotice("");
    if (!await enterCaptionFullscreen(wrapper, document.fullscreenEnabled)) {
      if (!wrapper.isConnected) return;
      setPageExpanded(true);
      setFullscreenNotice("此瀏覽器未允許原生全螢幕，已改為頁面放大，翻譯字幕仍會保留。");
    }
  };
  const collapse = async () => {
    if (document.fullscreenElement === wrapperRef.current) {
      try { await document.exitFullscreen(); }
      catch { setFullscreenNotice("請按 Esc 離開全螢幕。"); }
    }
    setPageExpanded(false);
    expandButtonRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (props.demo || !props.videoId) return;
    let disposed = false;
    let player: YouTubePlayer | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const host = hostRef.current;
    if (!host) return;
    const target = document.createElement("div");
    host.appendChild(target);
    loadYouTubeApi().then((api) => {
      if (disposed) return;
      player = new api.Player(target, {
        videoId: props.videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
          // Use our wrapper fullscreen so the sibling translated-caption layer stays visible.
          fs: 0,
          // 不依賴已停用的 modestbranding；原生 CC 仍可由使用者自行關閉。
          cc_load_policy: 0,
        },
        events: {
          onReady: () => {
            if (disposed || !player) return;
            const readyPlayer = player;
            pausePlayback.current = () => readyPlayer.pauseVideo();
            callbacksRef.current.onReady({
              seekTo: (seconds) => {
                readyPlayer.seekTo(seconds, true);
                callbacksRef.current.onTime(seconds);
              },
              pause: () => readyPlayer.pauseVideo(),
            });
            timer = setInterval(() => {
              if (disposed || !player) return;
              const time = player.getCurrentTime();
              if (Number.isFinite(time)) callbacksRef.current.onTime(time);
            }, 250);
          },
          onStateChange: ({ data }) => {
            if (!disposed && (data === 1 || data === 2 || data === 0)) callbacksRef.current.onPlaying(data === 1);
          },
          onError: () => {
            if (disposed) return;
            setPlayerError("這支影片無法嵌入播放。可改用 YouTube 原頁與手動載入的擴充套件。");
            callbacksRef.current.onPlaying(false);
          },
        },
      });
    }).catch((error: Error) => {
      if (!disposed) setPlayerError(error.message);
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      callbacksRef.current.onReady(null);
      pausePlayback.current = null;
      player?.destroy();
      host.replaceChildren();
    };
  }, [props.videoId, props.demo]);

  useEffect(() => {
    if (!props.demo || !props.playing) return;
    const timer = setInterval(() => {
      const next = Math.min(callbacksRef.current.time + 0.25, 35);
      callbacksRef.current.onTime(next);
      if (next >= 35) callbacksRef.current.onPlaying(false);
    }, 250);
    return () => clearInterval(timer);
  }, [props.demo, props.playing]);

  const showOriginal = props.captionMode === "bilingual" || props.captionMode === "original";
  const showTranslation = props.captionMode === "bilingual" || props.captionMode === "translated";
  const compact = playerWidth < 600;
  const translatedFont = compact ? 14 : 18;
  const originalFont = compact ? 11 : 12;
  const availableWidth = Math.max(60, Math.min(760, playerWidth - 48));
  // Reserve one glyph for closing punctuation; narrow screens receive shorter
  // pages instead of smaller type, clipping, ellipses or omitted text.
  const translatedLineUnits = Math.max(4, Math.min(compact ? 22 : 34, Math.floor(availableWidth / translatedFont) - 1));
  const originalLineUnits = Math.max(4, Math.min(compact ? 30 : 50, Math.floor(availableWidth / originalFont) - 1));
  const pageLineBudget = playerWidth < 360 ? 1 : 2;
  const translatedPages = useMemo(() => splitCaptionPages(props.translated, {
    lineUnits: translatedLineUnits, pageUnits: Math.min(32, translatedLineUnits * pageLineBudget), maxLines: 2,
  }), [props.translated, translatedLineUnits, pageLineBudget]);
  const originalPages = useMemo(() => splitCaptionPages(props.original, {
    lineUnits: originalLineUnits, pageUnits: Math.min(32, originalLineUnits * pageLineBudget), maxLines: 2,
  }), [props.original, originalLineUnits, pageLineBudget]);
  const interval = { start: props.cueStart, end: props.cueEnd, time: props.time };
  const translatedPage = selectCaptionPage(translatedPages, interval);
  const originalPage = selectCaptionPage(originalPages, interval);
  const hasCaptions = !!(props.original || props.translated);
  const dense = (showTranslation && translatedPage.dense) || (showOriginal && originalPage.dense);
  const hasPages = (showTranslation && translatedPage.total > 1) || (showOriginal && originalPage.total > 1);
  const pauseForFullCaption = () => {
    setFullCaption({ original: props.original, translated: props.translated, start: props.cueStart });
    if (props.demo) props.onPlaying(false);
    else pausePlayback.current?.();
  };
  return (
    <div>
      <div ref={wrapperRef} data-watch-player-shell data-expanded={expanded ? "true" : "false"}
        className="relative aspect-video overflow-hidden rounded-2xl bg-[#17191d] shadow-sm"
        style={expanded ? { position: pageExpanded ? "fixed" : "relative", inset: 0, width: "100vw", height: "100dvh", aspectRatio: "auto", borderRadius: 0, zIndex: 1000 } : undefined}>
        {props.demo ? (
          <div className="absolute inset-0 flex flex-col justify-center gap-5 px-5 pb-16 sm:px-12 text-white">
            <span className="absolute left-5 top-4 text-xs font-bold tracking-wider text-orange-300">DEMO · 示範播放器，非真實影片</span>
            <div className="flex items-center justify-center gap-2 sm:gap-4" aria-hidden="true">
              {["原始影片", "人物遮罩", "Compositor"].map((label, index) => (
                <div key={label} className="contents">
                  {index > 0 && <span className="text-orange-400">→</span>}
                  <div className="rounded-xl border border-white/15 bg-white/5 px-3 py-5 sm:px-6 text-xs sm:text-sm">
                    <span className="mb-3 block h-1.5 w-8 rounded-full bg-orange-400/80" />{label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : <div ref={hostRef} className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full" />}
        {playerError && (
          <div role="alert" className="absolute inset-x-5 top-5 rounded-lg bg-red-950/95 p-4 text-sm text-white">{playerError}</div>
        )}
        {props.captionMode !== "off" && (props.original || props.translated) && (
          <div className="pointer-events-none absolute inset-x-3 bottom-10 flex justify-center sm:bottom-12" aria-label="同步字幕（依原句時間近似分頁）">
            <div className="max-w-full rounded-lg bg-black/85 px-3 py-1.5 text-center text-white" style={{ maxWidth: Math.min(784, playerWidth - 24) }}>
              {showTranslation && (
                <p data-caption-language="translated" data-caption-page={translatedPage.index + 1} className={props.translated ? "font-semibold" : "text-orange-200"}
                  style={{ fontSize: props.translated ? translatedFont : 11, lineHeight: props.translated ? (compact ? "19px" : "25px") : "16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {translatedPage.page?.text || props.captionStatus}
                </p>
              )}
              {showOriginal && props.original && <p data-caption-language="original" data-caption-page={originalPage.index + 1} className="mt-0.5 text-gray-200"
                style={{ fontSize: originalFont, lineHeight: compact ? "15px" : "17px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{originalPage.page?.text}</p>}
            </div>
          </div>
        )}
        {expanded && <div className="absolute right-4 top-4 z-20 flex max-w-[80%] items-start gap-3">
          {fullscreenNotice && <p role="status" className="rounded-lg bg-black/85 p-3 text-xs text-white">{fullscreenNotice}</p>}
          <button ref={closeButtonRef} type="button" onClick={() => { void collapse(); }} className="shrink-0 rounded-lg border border-white/30 bg-black/85 px-4 py-3 text-sm font-bold text-white">縮回觀看</button>
        </div>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button ref={expandButtonRef} type="button" onClick={() => { void expand(); }} aria-expanded={expanded} className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-800 hover:bg-orange-50">放大觀看（含字幕）</button>
        <p className="text-xs text-gray-500">使用此按鈕保留翻譯字幕；Esc 或「縮回觀看」可返回。浮動子母畫面不支援外加字幕。</p>
      </div>
      {props.captionMode !== "off" && hasCaptions && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-relaxed text-gray-600">
        <span data-caption-page-status>{showTranslation && translatedPage.total > 0 && `繁中 ${translatedPage.index + 1}/${translatedPage.total}`}{showTranslation && translatedPage.total > 0 && showOriginal && originalPage.total > 0 && " · "}{showOriginal && originalPage.total > 0 && `原文 ${originalPage.index + 1}/${originalPage.total}`}</span>
        {hasPages && <span>依原句時間近似分頁，非逐字對齊；全文未刪改。</span>}
        <button type="button" onClick={pauseForFullCaption} className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1 font-semibold text-orange-800 hover:bg-orange-100">暫停看本句全文</button>
        {dense && <p className="w-full text-amber-800">本句時間短、內容較密，可暫停看全文；不會更改影片速度。右側逐字稿保留完整內容。</p>}
        {hasPages && !originalPage.timingKnown && !translatedPage.timingKnown && <p className="w-full text-amber-800">本句時間尚未提供，先顯示第一頁；請開啟全文閱讀。</p>}
      </div>}
      {fullCaption && <section aria-label="本句完整字幕" className="mt-3 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-gray-800">
        <div className="mb-2 flex items-center justify-between gap-3"><h3 className="font-bold">本句全文 · 保留點擊時的字幕{Number.isFinite(fullCaption.start) ? `（${Math.floor(fullCaption.start! / 60)}:${Math.floor(fullCaption.start! % 60).toString().padStart(2, "0")}）` : ""}</h3><button type="button" onClick={() => setFullCaption(null)} className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-orange-800 hover:bg-orange-100">收合全文</button></div>
        {fullCaption.translated && <p className="whitespace-pre-wrap break-words leading-relaxed">{fullCaption.translated}</p>}
        {fullCaption.original && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-600">{fullCaption.original}</p>}
        <p className="mt-2 text-[11px] text-gray-500">文字沒有摘要或省略。讀完後可自行恢復影片播放。</p>
      </section>}
      {props.demo && (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 p-3">
          <button type="button" onClick={() => props.onPlaying(!props.playing)} className="shrink-0 rounded-lg bg-white px-3 py-2 text-sm font-bold text-orange-700 ring-1 ring-orange-200">
            {props.playing ? "暫停示範" : "播放示範"}
          </button>
          <input type="range" aria-label="示範播放時間" min="0" max="35" step="0.1" value={props.time} onChange={(event) => props.onTime(Number(event.target.value))} className="min-w-0 flex-1 accent-orange-500" />
          <span className="w-16 text-right text-xs tabular-nums text-gray-600">{Math.floor(props.time)} / 35 秒</span>
        </div>
      )}
    </div>
  );
}
