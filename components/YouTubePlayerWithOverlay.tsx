"use client";

/**
 * YouTube iframe + 自製雙語字幕 overlay。
 *
 * 為什麼要自製: YouTube iframe 是 cross-origin sandbox,沒辦法塞 <track> 也沒辦法讓
 * 瀏覽器跳出原生 PiP 跟字幕選單。但我們可以透過 postMessage 跟 IFrame Player API
 * 溝通拿 currentTime + playerState,然後在 iframe 上方絕對定位一層自己的字幕 div。
 *
 * 字幕模式: 雙語 / 原文 / 中譯 / 關。若影片沒翻譯則自動 fallback 成單語。
 *
 * 不會佔本機磁碟,影片直接從 YouTube 串流。代價是失去瀏覽器原生 PiP/字幕選單,
 * 想要原生選單請走 C 路徑(下載 mp4 + VideoPlayerPanel)。
 */

import { useEffect, useRef, useState } from "react";

export interface Segment {
  start: number;
  end?: number;
  text: string;
}

type SubMode = "bilingual" | "original" | "translated" | "off";

interface Props {
  videoId: string;
  segments: Segment[];
  segmentsZh?: Segment[] | null;
  isTranslated: boolean;
  initialSeekSec?: number | null;
  // Optional: 父層想知道現在時間(例如做逐字稿 auto-scroll)
  onTimeUpdate?: (t: number) => void;
  // Optional: 父層想 seek (回傳一個 ref-like setter)
  onPlayerReady?: (api: { seekTo: (t: number) => void }) => void;
}

export default function YouTubePlayerWithOverlay({
  videoId,
  segments,
  segmentsZh,
  isTranslated,
  initialSeekSec,
  onTimeUpdate,
  onPlayerReady,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialSeekDone = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [subMode, setSubMode] = useState<SubMode>(isTranslated ? "bilingual" : "original");
  const [isPiP, setIsPiP] = useState(false);

  function seekTo(seconds: number) {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: "seekTo", args: [seconds, true] }),
      "*"
    );
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: "playVideo", args: [] }),
      "*"
    );
  }

  function replayCurrent() {
    if (activeIndex < 0) return;
    const seg = segments[activeIndex];
    if (seg) seekTo(seg.start);
  }

  // 找出當前 segment index (依英文 segments 為準,zh 是 1:1 對齊)
  const activeIndex = segments.findIndex((seg, i) => {
    const next = segments[i + 1];
    return currentTime >= seg.start && (next ? currentTime < next.start : true);
  });

  const activeOriginal = activeIndex >= 0 ? segments[activeIndex] : null;
  const activeTranslated =
    activeIndex >= 0 && segmentsZh && segmentsZh[activeIndex] ? segmentsZh[activeIndex] : null;

  // === postMessage 收 YouTube IFrame API 資料 ===
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (typeof e.data !== "string") return;
      try {
        const data = JSON.parse(e.data);
        if (data.event === "infoDelivery" && data.info) {
          if (typeof data.info.currentTime === "number") {
            setCurrentTime(data.info.currentTime);
            onTimeUpdate?.(data.info.currentTime);
          }
        }
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onTimeUpdate]);

  // === 主動跟 iframe 說「我在聽」+ 之後每 300ms 重發確保 YouTube player keep streaming ===
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    function sendListening() {
      iframe?.contentWindow?.postMessage(JSON.stringify({ event: "listening" }), "*");
    }

    const onLoad = () => {
      sendListening();
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(sendListening, 300);

      // 初始 seek (從 #t=N 來的)
      if (!initialSeekDone.current && typeof initialSeekSec === "number" && initialSeekSec > 0) {
        initialSeekDone.current = true;
        setTimeout(() => {
          iframe?.contentWindow?.postMessage(
            JSON.stringify({ event: "command", func: "seekTo", args: [initialSeekSec, true] }),
            "*"
          );
          iframe?.contentWindow?.postMessage(
            JSON.stringify({ event: "command", func: "playVideo", args: [] }),
            "*"
          );
        }, 800);
      }
    };

    iframe.addEventListener("load", onLoad);
    sendListening();

    // 暴露 seekTo 給父層
    onPlayerReady?.({
      seekTo: (t: number) => {
        iframe?.contentWindow?.postMessage(
          JSON.stringify({ event: "command", func: "seekTo", args: [t, true] }),
          "*"
        );
        iframe?.contentWindow?.postMessage(
          JSON.stringify({ event: "command", func: "playVideo", args: [] }),
          "*"
        );
      },
    });

    return () => {
      iframe.removeEventListener("load", onLoad);
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [initialSeekSec, onPlayerReady]);

  const showOriginal = subMode === "bilingual" || subMode === "original";
  const showTranslated = (subMode === "bilingual" || subMode === "translated") && isTranslated && !!activeTranslated;
  const overlayVisible = subMode !== "off" && (showOriginal || showTranslated);

  // 字幕模式 picker 選項(依是否有翻譯動態收斂)
  const modes: { value: SubMode; label: string }[] = isTranslated
    ? [
        { value: "bilingual", label: "雙語" },
        { value: "original", label: "原文" },
        { value: "translated", label: "中譯" },
        { value: "off", label: "關" },
      ]
    : [
        { value: "original", label: "字幕" },
        { value: "off", label: "關" },
      ];

  // YouTube iframe 參數: 隱藏原生 CC 避免雙重字幕
  // - cc_load_policy=0: 不載 CC 軌
  // - iv_load_policy=3: 不載互動標註
  // - modestbranding=1: 隱藏 YouTube logo
  // - rel=0: 不顯示相關影片
  // - enablejsapi=1: 開啟 postMessage API
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&cc_load_policy=0&iv_load_policy=3&modestbranding=1&rel=0&origin=${origin}`;

  const subtitleOverlay =
    overlayVisible && ((showOriginal && activeOriginal) || (showTranslated && activeTranslated)) ? (
      <div className={`pointer-events-none absolute inset-x-0 ${isPiP ? "bottom-2 px-2" : "bottom-16 px-4"} z-10 flex justify-center`}>
        <button
          type="button"
          onClick={replayCurrent}
          className={`pointer-events-auto ${isPiP ? "max-w-full" : "max-w-3xl"} w-full bg-black/75 text-white rounded-md ${isPiP ? "px-2 py-1" : "px-5 py-3"} backdrop-blur-sm text-center hover:bg-black/85 transition-colors cursor-pointer`}
          title="點擊重播這一句"
        >
          {showTranslated && activeTranslated && (
            <div className={`${isPiP ? "text-xs" : "text-lg sm:text-xl"} font-bold leading-snug`}>{activeTranslated.text}</div>
          )}
          {showOriginal && activeOriginal && (
            <div className={`${isPiP ? "text-[10px]" : "text-sm sm:text-base"} text-gray-200 leading-snug ${showTranslated ? "mt-0.5" : ""}`}>
              {activeOriginal.text}
            </div>
          )}
        </button>
      </div>
    ) : null;

  return (
    <div className="relative">
      {/* PiP 模式時原位置顯示佔位框,避免 layout shift */}
      {isPiP && (
        <div className="aspect-video rounded-xl bg-gray-50 border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 text-sm">
          影片正在子母畫面中(右下角)
        </div>
      )}

      {/* 影片 + 字幕 overlay 用同一個 wrapper, 進 PiP 時整組一起移到右下 fixed */}
      <div
        className={
          isPiP
            ? "fixed bottom-4 right-4 w-[360px] z-50 shadow-2xl rounded-xl overflow-hidden ring-4 ring-white/90"
            : ""
        }
      >
        <div className="relative aspect-video rounded-xl overflow-hidden shadow-lg bg-black">
          <iframe
            ref={iframeRef}
            src={src}
            className="w-full h-full"
            allowFullScreen
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          />
          {/* PiP 模式時容器內顯示「離開」浮動按鈕 */}
          {isPiP && (
            <button
              type="button"
              onClick={() => setIsPiP(false)}
              className="absolute top-1.5 right-1.5 z-30 bg-black/70 hover:bg-black/90 text-white text-[11px] font-bold px-2 py-1 rounded backdrop-blur-sm"
              title="離開子母畫面"
            >
              離開 PiP
            </button>
          )}
          {subtitleOverlay}
        </div>
      </div>

      {/* === 字幕模式切換 picker + PiP toggle === */}
      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-gray-400">
          {currentTime > 0 ? `${formatTime(currentTime)} · 字幕 overlay 模式(零本機磁碟)` : "字幕 overlay 模式(零本機磁碟)"}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsPiP((v) => !v)}
            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
              isPiP
                ? "bg-orange-100 text-orange-700 hover:bg-orange-200"
                : "bg-gray-100 text-gray-500 hover:text-gray-700"
            }`}
            title={isPiP ? "離開子母畫面" : "進入子母畫面 (右下角浮動)"}
          >
            {isPiP ? "離開 PiP" : "子母畫面"}
          </button>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {modes.map((m) => (
              <button
                key={m.value}
                onClick={() => setSubMode(m.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                  subMode === m.value
                    ? "bg-white text-orange-600 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTime(s: number): string {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
