"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";

interface SubtitleCue {
  text: string;
  video_start: number;
  video_end: number;
}

interface CleanSegment {
  clip_index: number;
  start: number;
  end: number;
  subtitle: string;
  original_text?: string;
}

interface ProjectData {
  id: string;
  title: string;
  status: string;
  total_duration_display: string;
  video_path: string | null;
  video_script: {
    hook: string;
    segments: CleanSegment[];
    cta: string;
    total_duration?: number;
    subtitle_cues?: SubtitleCue[];
  } | null;
  combined_summary: {
    title_display: string;
    one_liner: string;
    key_points: { label: string; content: string }[];
    key_quote: string;
    action_items: string[];
    tags: string[];
  } | null;
  card_paths: string[] | null;
  clips: Array<{
    id: string;
    sort_order: number;
    file_name: string;
    duration_display: string;
    transcript: string;
    status: string;
  }>;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function RemixDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ProjectData | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [view, setView] = useState<"video" | "carousel" | "script" | "clips">(
    "video"
  );
  const [activeCue, setActiveCue] = useState(-1);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        // Default to carousel if no video
        if (!d.video_path) setView("carousel");
      });
  }, [id]);

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  if (data.status !== "done") {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4">
        {data.status === "processing" ? (
          <>
            <div className="w-10 h-10 border-3 border-orange-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-500">Processing...</p>
          </>
        ) : (
          <p className="text-red-400">Processing failed</p>
        )}
        <Link
          href="/remix"
          className="text-orange-500 hover:underline text-sm"
        >
          Back to Remix
        </Link>
      </div>
    );
  }

  const summary = data.combined_summary;
  const slides = data.card_paths || [];
  const script = data.video_script;
  const cues = script?.subtitle_cues || [];

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <Link
            href="/remix"
            className="text-sm text-gray-400 hover:text-orange-500"
          >
            &larr; Back
          </Link>
          <div className="flex gap-2">
            {data.video_path && (
              <button
                onClick={() => setView("video")}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  view === "video"
                    ? "bg-orange-500 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                Video
              </button>
            )}
            <button
              onClick={() => setView("carousel")}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                view === "carousel"
                  ? "bg-orange-500 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              Summary Cards
            </button>
            {script && (
              <button
                onClick={() => setView("script")}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  view === "script"
                    ? "bg-orange-500 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                Script
              </button>
            )}
            <button
              onClick={() => setView("clips")}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                view === "clips"
                  ? "bg-orange-500 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              Transcripts
            </button>
          </div>
        </div>

        {/* Video view with interactive transcript */}
        {view === "video" && data.video_path && (
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 max-w-5xl mx-auto">
            {/* Video player */}
            <div className="lg:col-span-2">
              <video
                ref={videoRef}
                src={data.video_path}
                controls
                className="w-full rounded-xl shadow-lg sticky top-4"
                style={{ maxHeight: "70vh" }}
                onTimeUpdate={() => {
                  const v = videoRef.current;
                  if (!v || !cues.length) return;
                  const t = v.currentTime;
                  const idx = cues.findIndex(
                    (c) => t >= c.video_start && t < c.video_end
                  );
                  if (idx !== activeCue) setActiveCue(idx);
                }}
              />
              <div className="mt-3 flex items-center justify-between">
                <p className="text-sm text-gray-500">
                  {data.clips.length} clip{data.clips.length > 1 ? "s" : ""} / {data.total_duration_display}
                </p>
                <div className="flex gap-2">
                  <a
                    href={data.video_path}
                    download="remix.mp4"
                    className="px-3 py-1.5 bg-orange-500 text-white text-xs font-bold rounded-lg hover:bg-orange-600 transition-colors"
                  >
                    Download MP4
                  </a>
                  <a
                    href={`/api/projects/${id}/srt?type=video`}
                    download
                    className="px-3 py-1.5 bg-gray-700 text-white text-xs font-bold rounded-lg hover:bg-gray-800 transition-colors"
                  >
                    Download SRT
                  </a>
                </div>
              </div>
            </div>

            {/* Interactive subtitle transcript */}
            <div className="lg:col-span-3">
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wider mb-3">
                Subtitles ({cues.length})
              </h2>
              <div className="space-y-1.5 max-h-[70vh] overflow-y-auto">
                {cues.map((cue, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      const v = videoRef.current;
                      if (v) {
                        v.currentTime = cue.video_start;
                        v.play();
                      }
                      setActiveCue(i);
                    }}
                    className={`w-full text-left px-4 py-3 rounded-lg transition-all flex items-start gap-3 ${
                      i === activeCue
                        ? "bg-orange-50 border border-orange-300 shadow-sm"
                        : "bg-white border border-gray-100 hover:border-orange-200 hover:bg-orange-50/30"
                    }`}
                  >
                    <span className={`text-xs font-mono mt-0.5 flex-shrink-0 ${
                      i === activeCue ? "text-orange-500 font-bold" : "text-gray-400"
                    }`}>
                      {formatTime(cue.video_start)}
                    </span>
                    <span className={`text-sm ${
                      i === activeCue ? "text-gray-900 font-medium" : "text-gray-600"
                    }`}>
                      {cue.text}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Carousel view */}
        {view === "carousel" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div>
              {slides.length > 0 && (
                <div className="relative">
                  <div className="aspect-[4/5] relative rounded-xl overflow-hidden shadow-lg">
                    <Image
                      src={slides[currentSlide]}
                      alt={`Slide ${currentSlide + 1}`}
                      fill
                      className="object-cover"
                    />
                  </div>
                  {slides.length > 1 && (
                    <div className="flex items-center justify-center gap-4 mt-4">
                      <button
                        onClick={() =>
                          setCurrentSlide((p) =>
                            p > 0 ? p - 1 : slides.length - 1
                          )
                        }
                        className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 hover:bg-gray-200"
                      >
                        &larr;
                      </button>
                      <div className="flex gap-1.5">
                        {slides.map((_, i) => (
                          <button
                            key={i}
                            onClick={() => setCurrentSlide(i)}
                            className={`w-2 h-2 rounded-full transition-colors ${
                              i === currentSlide
                                ? "bg-orange-500"
                                : "bg-gray-300"
                            }`}
                          />
                        ))}
                      </div>
                      <button
                        onClick={() =>
                          setCurrentSlide((p) =>
                            p < slides.length - 1 ? p + 1 : 0
                          )
                        }
                        className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 hover:bg-gray-200"
                      >
                        &rarr;
                      </button>
                    </div>
                  )}
                  <div className="mt-4 text-center">
                    <a
                      href={slides[currentSlide]}
                      download
                      className="text-sm text-orange-500 hover:underline"
                    >
                      Download slide {currentSlide + 1}
                    </a>
                  </div>
                </div>
              )}
            </div>

            {summary && (
              <div className="space-y-6">
                <div>
                  <p className="text-xs text-orange-500 font-bold uppercase tracking-wider mb-1">
                    {data.clips.length} clips / {data.total_duration_display}
                  </p>
                  <h1 className="text-2xl font-black text-gray-900">
                    {summary.title_display}
                  </h1>
                  <p className="text-gray-500 mt-1">{summary.one_liner}</p>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider">
                    Key Points
                  </h3>
                  {summary.key_points.map((kp, i) => (
                    <div key={i} className="p-3 bg-orange-50 rounded-lg">
                      <span className="text-xs font-bold text-orange-600">
                        {kp.label}
                      </span>
                      <p className="text-sm text-gray-700 mt-0.5">
                        {kp.content}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="p-4 bg-gray-50 rounded-lg border-l-4 border-orange-400">
                  <p className="text-gray-700 italic">
                    &ldquo;{summary.key_quote}&rdquo;
                  </p>
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider">
                    Action Items
                  </h3>
                  {summary.action_items.map((item, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="w-4 h-4 mt-0.5 rounded border border-orange-300 flex-shrink-0" />
                      <span className="text-sm text-gray-700">{item}</span>
                    </div>
                  ))}
                </div>

                <div className="flex gap-1.5 flex-wrap">
                  {summary.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-2 py-0.5 rounded-full border border-orange-300 text-orange-600"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Script view */}
        {view === "script" && script && (
          <div className="max-w-2xl mx-auto space-y-6">
            {/* Hook */}
            <div className="bg-orange-500 text-white rounded-xl p-6">
              <p className="text-xs font-bold uppercase tracking-wider opacity-80 mb-2">
                Hook (0:00 - 0:03)
              </p>
              <p className="text-xl font-bold">{script.hook}</p>
            </div>

            {/* Segments */}
            {script.segments.map((seg, i) => {
              const clipName =
                data.clips.find((c) => c.sort_order === seg.clip_index - 1)
                  ?.file_name || `Clip ${seg.clip_index}`;
              return (
                <div
                  key={i}
                  className="bg-white rounded-xl border border-gray-100 p-5"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white bg-gray-700 px-2 py-0.5 rounded-full">
                        #{i + 1}
                      </span>
                      <span className="text-xs text-gray-400">{clipName}</span>
                    </div>
                    <span className="text-xs text-gray-400 font-mono">
                      {formatTime(seg.start)} - {formatTime(seg.end)} (
                      {Math.round(seg.end - seg.start)}s)
                    </span>
                  </div>
                  <p className="text-gray-800 font-medium">{seg.subtitle}</p>
                  {seg.original_text && seg.original_text !== seg.subtitle && (
                    <p className="text-xs text-gray-400 mt-1 line-clamp-2">
                      Original: {seg.original_text}
                    </p>
                  )}
                </div>
              );
            })}

            {/* CTA */}
            <div className="bg-gray-900 text-white rounded-xl p-6">
              <p className="text-xs font-bold uppercase tracking-wider opacity-60 mb-2">
                CTA (ending)
              </p>
              <p className="text-xl font-bold">{script.cta}</p>
            </div>

            {/* Total duration */}
            <div className="text-center text-sm text-gray-400">
              Video length:{" "}
              {script.total_duration
                ? `${Math.round(script.total_duration)}s content`
                : `${Math.round(script.segments.reduce((sum, s) => sum + (s.end - s.start), 0))}s content`}
              {" "}+ 6s (title + CTA)
            </div>
          </div>
        )}

        {/* Clips transcript view */}
        {view === "clips" && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="flex justify-end">
              <a
                href={`/api/projects/${id}/srt?type=clips`}
                download
                className="px-4 py-2 bg-gray-700 text-white text-sm font-bold rounded-lg hover:bg-gray-800 transition-colors"
              >
                Download All Clips SRT
              </a>
            </div>
            {data.clips.map((clip) => (
              <div
                key={clip.id}
                className="bg-white rounded-xl border border-gray-100 p-6"
              >
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-xs font-bold text-white bg-orange-500 px-2 py-0.5 rounded-full">
                    #{clip.sort_order + 1}
                  </span>
                  <span className="text-sm font-medium text-gray-700">
                    {clip.file_name}
                  </span>
                  <span className="text-xs text-gray-400">
                    {clip.duration_display}
                  </span>
                </div>
                <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">
                  {clip.transcript || "(No transcript)"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
