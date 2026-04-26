"use client";

import { useRef, useState, useEffect, useCallback } from "react";

interface Segment {
  start: number;
  end: number;
  text: string;
}

interface Highlight {
  timestamp: number;
  label: string;
  description: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function TranscriptView({
  segments,
  segmentsZh,
  highlights,
  videoId,
  isTranslated,
  summary,
  source = "youtube",
  podcastUrl,
}: {
  segments: Segment[];
  segmentsZh: Segment[] | null;
  highlights: Highlight[];
  videoId: string;
  isTranslated: boolean;
  summary: Record<string, unknown> | null;
  source?: string;
  podcastUrl?: string;
}) {
  const [tab, setTab] = useState<"highlights" | "full">("highlights");
  const [lang, setLang] = useState<"zh" | "original">(isTranslated ? "zh" : "original");
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playerRef = useRef<HTMLIFrameElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const displaySegments = lang === "zh" && segmentsZh ? segmentsZh : segments;
  const originalSegments = segments;

  const activeIndex = displaySegments.findIndex((seg, i) => {
    const next = displaySegments[i + 1];
    return currentTime >= seg.start && (next ? currentTime < next.start : true);
  });

  // Listen for YouTube player postMessage
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (typeof e.data !== "string") return;
      try {
        const data = JSON.parse(e.data);
        if (data.event === "infoDelivery" && data.info) {
          if (typeof data.info.currentTime === "number") {
            setCurrentTime(data.info.currentTime);
          }
          if (typeof data.info.playerState === "number") {
            setIsPlaying(data.info.playerState === 1);
          }
        }
      } catch {
        // ignore
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Start listening to iframe
  useEffect(() => {
    const iframe = playerRef.current;
    if (!iframe) return;

    function sendListening() {
      iframe?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening" }),
        "*"
      );
    }

    const onLoad = () => {
      sendListening();
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(sendListening, 300);
    };

    iframe.addEventListener("load", onLoad);
    sendListening();

    return () => {
      iframe.removeEventListener("load", onLoad);
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  // Auto-scroll control: user interaction disables auto-scroll
  const autoScrollEnabled = useRef(false); // starts disabled
  const isAutoScrolling = useRef(false);
  const lastAutoScrollIndex = useRef(-1);

  // Detect user manual scroll vs programmatic scroll
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    function onScroll() {
      // If we triggered this scroll programmatically, ignore
      if (isAutoScrolling.current) return;
      // User scrolled manually, disable auto-scroll
      autoScrollEnabled.current = false;
    }

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Reset on tab switch
  const prevTabRef = useRef(tab);
  useEffect(() => {
    if (prevTabRef.current !== tab) {
      prevTabRef.current = tab;
      lastAutoScrollIndex.current = activeIndex;
      autoScrollEnabled.current = false;
    }
  }, [tab, activeIndex]);

  // Auto-scroll: only when enabled and segment changes by 1
  useEffect(() => {
    if (tab !== "full" || activeIndex < 0) return;
    if (activeIndex === lastAutoScrollIndex.current) return;

    const diff = activeIndex - lastAutoScrollIndex.current;
    lastAutoScrollIndex.current = activeIndex;

    // Only auto-scroll for natural playback (advancing by 1 segment)
    if (diff !== 1) {
      autoScrollEnabled.current = false;
      return;
    }

    if (!autoScrollEnabled.current) return;

    const container = scrollContainerRef.current;
    const el = activeRef.current;
    if (!container || !el) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    const margin = containerRect.height * 0.25;
    if (elRect.top < containerRect.top + margin || elRect.bottom > containerRect.bottom - margin) {
      isAutoScrolling.current = true;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => { isAutoScrolling.current = false; }, 500);
    }
  }, [activeIndex, tab]);

  const seekTo = useCallback((seconds: number) => {
    if (source === "youtube" && playerRef.current?.contentWindow) {
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({ event: "command", func: "seekTo", args: [seconds, true] }),
        "*"
      );
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({ event: "command", func: "playVideo", args: [] }),
        "*"
      );
    } else if (source === "podcast" && audioRef.current) {
      audioRef.current.currentTime = seconds;
      audioRef.current.play();
    }
    setCurrentTime(seconds);
    autoScrollEnabled.current = true;
  }, [source]);

  return (
    <div>
      {/* === PLAYER (YouTube or Podcast audio) === */}
      <div className="w-full mb-6">
        {source === "youtube" ? (
          <div className="aspect-video rounded-2xl overflow-hidden shadow-xl">
            <iframe
              ref={playerRef}
              src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${typeof window !== "undefined" ? window.location.origin : ""}`}
              className="w-full h-full"
              allowFullScreen
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            />
          </div>
        ) : (
          <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-2xl shadow-xl p-8">
            <p className="text-purple-700 font-bold text-lg mb-4 text-center">Podcast 音訊播放</p>
            {podcastUrl && (
              <audio
                ref={audioRef as React.RefObject<HTMLAudioElement>}
                src={podcastUrl}
                controls
                className="w-full"
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
            )}
          </div>
        )}
        {/* Now playing bar (bilingual, centered) */}
        {activeIndex >= 0 && (
          <div className="mt-4 bg-orange-50 border-2 border-orange-300 rounded-xl px-8 py-5 text-center">
            <div className="flex items-center justify-center gap-3 mb-3">
              <span className={`inline-block w-3 h-3 rounded-full ${isPlaying ? "bg-orange-500 animate-pulse" : "bg-gray-400"}`} />
              <span className="text-xl text-orange-700 font-bold font-mono">
                {formatTime(currentTime)}
              </span>
            </div>
            <p className="text-2xl font-bold text-orange-800 leading-relaxed">
              {isTranslated && segmentsZh?.[activeIndex]
                ? segmentsZh[activeIndex].text
                : displaySegments[activeIndex]?.text}
            </p>
            {isTranslated && originalSegments[activeIndex] && (
              <p className="text-xl text-orange-500 leading-relaxed mt-2">
                {originalSegments[activeIndex].text}
              </p>
            )}
          </div>
        )}
      </div>

      {/* === TWO COLUMN: Transcript | Summary === */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Transcript (2/3 width) */}
        <div className="lg:col-span-2">
          {/* Tab + lang switcher */}
          <div className="flex items-center gap-2 mb-3">
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 flex-1">
              <button
                onClick={() => setTab("highlights")}
                className={`flex-1 py-2 rounded-md text-sm font-bold transition-colors ${
                  tab === "highlights" ? "bg-white text-orange-600 shadow-sm" : "text-gray-500"
                }`}
              >
                精華片段 ({highlights.length}個)
              </button>
              <button
                onClick={() => setTab("full")}
                className={`flex-1 py-2 rounded-md text-sm font-bold transition-colors ${
                  tab === "full" ? "bg-white text-orange-600 shadow-sm" : "text-gray-500"
                }`}
              >
                完整逐字稿 ({displaySegments.length}段)
              </button>
            </div>

            {isTranslated && tab === "full" && (
              <div className="flex gap-1 bg-gray-50 rounded-lg p-1 shrink-0">
                <button
                  onClick={() => setLang("zh")}
                  className={`px-3 py-2 rounded-md text-xs font-bold transition-colors ${
                    lang === "zh" ? "bg-orange-500 text-white" : "text-gray-500"
                  }`}
                >
                  中文
                </button>
                <button
                  onClick={() => setLang("original")}
                  className={`px-3 py-2 rounded-md text-xs font-bold transition-colors ${
                    lang === "original" ? "bg-gray-600 text-white" : "text-gray-500"
                  }`}
                >
                  原文
                </button>
              </div>
            )}
          </div>

          {/* Highlights */}
          {tab === "highlights" && (
            <div className="space-y-3">
              {highlights.map((h, i) => {
                const isActive = currentTime >= h.timestamp &&
                  (highlights[i + 1] ? currentTime < highlights[i + 1].timestamp : true);
                return (
                  <button
                    key={i}
                    onClick={() => seekTo(h.timestamp)}
                    className={`w-full text-left p-4 rounded-xl border transition-all hover:shadow-md ${
                      isActive
                        ? "border-orange-400 bg-orange-50 shadow-md"
                        : "border-gray-100 bg-white hover:border-orange-200"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`shrink-0 px-2.5 py-1 text-xs font-bold rounded-md mt-0.5 ${
                        isActive ? "bg-orange-500 text-white" : "bg-orange-100 text-orange-600"
                      }`}>
                        {formatTime(h.timestamp)}
                      </span>
                      <div className="flex-1">
                        <p className="font-bold text-gray-900 text-sm">{h.label}</p>
                        <p className="text-gray-500 text-sm mt-1">{h.description}</p>
                      </div>
                      {isActive && <span className="shrink-0 w-2.5 h-2.5 rounded-full bg-orange-500 animate-pulse mt-2" />}
                    </div>
                  </button>
                );
              })}
              {highlights.length === 0 && (
                <p className="text-center text-gray-400 py-8 text-sm">沒有精華片段資料</p>
              )}
            </div>
          )}

          {/* Full transcript */}
          {tab === "full" && (
            <div
              ref={scrollContainerRef}
              className="max-h-[calc(100vh-400px)] overflow-y-auto rounded-xl border border-gray-100 bg-white scroll-smooth"
            >
              {isTranslated && lang === "zh" && (
                <div className="sticky top-0 z-10 bg-orange-50 border-b border-orange-100 px-4 py-2 text-xs text-orange-600 font-bold">
                  AI 翻譯繁體中文版本
                </div>
              )}
              {displaySegments.map((seg, i) => {
                const isActive = i === activeIndex;
                const otherText = isTranslated
                  ? (lang === "zh" ? originalSegments[i]?.text : segmentsZh?.[i]?.text)
                  : null;

                return (
                  <button
                    key={i}
                    ref={isActive ? activeRef : null}
                    onClick={() => seekTo(seg.start)}
                    className={`w-full text-center flex flex-col items-center gap-1 px-6 py-5 border-b border-gray-100 transition-colors hover:bg-orange-50 ${
                      isActive ? "bg-orange-50 border-l-4 border-l-orange-500" : ""
                    }`}
                  >
                    <span className={`text-sm font-mono font-bold ${
                      isActive ? "text-orange-600" : "text-orange-400"
                    }`}>
                      {formatTime(seg.start)}
                    </span>
                    <span className={`text-xl leading-relaxed ${
                      isActive ? "text-gray-900 font-bold" : "text-gray-700"
                    }`}>
                      {seg.text}
                    </span>
                    {otherText && otherText !== seg.text && (
                      <span className="text-lg text-gray-400 leading-relaxed mt-1">
                        {otherText}
                      </span>
                    )}
                    {isActive && <span className="w-3 h-3 rounded-full bg-orange-500 animate-pulse mt-1" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Summary sidebar (1/3 width) */}
        <div className="lg:col-span-1">
          <div className="sticky top-4 space-y-5">
            {summary && (
              <>
                <p className="text-gray-600">{summary.one_liner as string}</p>

                <div>
                  <h3 className="text-xs font-bold text-orange-500 uppercase tracking-widest mb-2">重點摘要</h3>
                  <div className="space-y-2">
                    {(summary.key_points as { label: string; content: string }[])?.map((kp, i) => (
                      <div key={i} className="border-l-3 border-orange-400 bg-orange-50 rounded-r-lg p-3">
                        <p className="font-bold text-orange-600 text-xs">{kp.label}</p>
                        <p className="text-gray-700 text-sm">{kp.content}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {typeof summary.key_quote === "string" && summary.key_quote && (
                  <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-xl p-4">
                    <p className="text-xl text-orange-400 font-black leading-none mb-1">&ldquo;</p>
                    <p className="text-gray-700 italic text-sm leading-relaxed">{summary.key_quote}</p>
                  </div>
                )}

                {(summary.action_items as string[])?.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-orange-500 uppercase tracking-widest mb-2">行動建議</h3>
                    <div className="space-y-1.5">
                      {(summary.action_items as string[]).map((item, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <div className="w-4 h-4 mt-0.5 border-2 border-orange-400 rounded flex-shrink-0" />
                          <p className="text-gray-700 text-sm">{item}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(summary.tags as string[])?.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap">
                    {(summary.tags as string[]).map((tag) => (
                      <span key={tag} className="text-xs px-2 py-0.5 rounded-full border border-orange-300 text-orange-600">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
