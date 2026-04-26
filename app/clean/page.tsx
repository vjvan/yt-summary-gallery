"use client";

import { useCallback, useRef, useState } from "react";

const VALID_EXTS = ["mp4", "mov", "webm", "avi", "mkv", "mp3", "m4a", "wav", "ogg"];

interface TimelineItem {
  id: number;
  type: "phrase" | "silence" | "filler";
  text: string;
  start: number;
  end: number;
  duration: number;
  selected: boolean;
  reason?: string;
}

interface CleanResult {
  videoPath: string;
  srtPath: string;
  originalDuration: number;
  cleanDuration: number;
  removedCount: number;
}

type Phase = "idle" | "uploading" | "processing" | "editing" | "assembling" | "done" | "error";

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function CleanPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [processStep, setProcessStep] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");

  // Analysis state
  const [jobId, setJobId] = useState("");
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [originalDuration, setOriginalDuration] = useState(0);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);

  // Result state
  const [result, setResult] = useState<CleanResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // ===== Upload + Analyze =====
  const processVideo = useCallback(async (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!ext || !VALID_EXTS.includes(ext)) {
      setError("不支援的格式");
      return;
    }

    setFileName(file.name);
    setError("");
    setResult(null);
    setItems([]);
    setPhase("uploading");

    const previewUrl = URL.createObjectURL(file);
    setVideoPreview(previewUrl);

    try {
      const formData = new FormData();
      formData.append("file", file);
      setPhase("processing");
      setProcessStep("uploading");

      const resp = await fetch("/api/clean", { method: "POST", body: formData });
      const data = await resp.json();
      if (!data.jobId) throw new Error("上傳失敗");
      setJobId(data.jobId);

      // Poll for analysis
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollResp = await fetch(`/api/clean?id=${data.jobId}`);
        const pollData = await pollResp.json();

        if (pollData.status === "analyzed") {
          setItems(pollData.items || []);
          setOriginalDuration(pollData.originalDuration || 0);
          setPhase("editing");
          return;
        }

        if (pollData.status === "error") {
          throw new Error(pollData.error || "分析失敗");
        }

        setProcessStep(pollData.detail || pollData.step || "");
      }

      throw new Error("處理逾時");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  // ===== Toggle item selection =====
  const toggleItem = (id: number) => {
    setItems((prev) => prev.map((item) =>
      item.id === id ? { ...item, selected: !item.selected } : item
    ));
  };

  // ===== Clear all selections =====
  const clearSelections = () => {
    setItems((prev) => prev.map((item) => ({ ...item, selected: false })));
  };

  // ===== Select all of a type =====
  const selectAllSilences = () => {
    setItems((prev) => prev.map((item) =>
      item.type === "silence" ? { ...item, selected: true } : item
    ));
  };

  const selectAllFillers = () => {
    setItems((prev) => prev.map((item) =>
      item.type === "filler" ? { ...item, selected: true } : item
    ));
  };

  // ===== Assemble =====
  const handleAssemble = async () => {
    const keepIds = items.filter((i) => !i.selected).map((i) => i.id);
    if (keepIds.length === 0) {
      setError("至少要保留一個片段");
      return;
    }

    setPhase("assembling");
    setError("");

    try {
      const resp = await fetch("/api/clean/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, keepItemIds: keepIds }),
      });

      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      setResult(data);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "組裝失敗");
    }
  };

  // ===== Reset =====
  const reset = () => {
    setPhase("idle");
    setError("");
    setResult(null);
    setItems([]);
    setFileName("");
    setJobId("");
    if (videoPreview) URL.revokeObjectURL(videoPreview);
    setVideoPreview(null);
  };

  // ===== Computed =====
  const selectedCount = items.filter((i) => i.selected).length;
  const estimatedDuration = items
    .filter((i) => !i.selected)
    .reduce((sum, i) => sum + i.duration, 0);

  // ===== Seek video on item click =====
  const seekTo = (time: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = time;
      v.play();
    }
  };

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      {/* === IDLE: Drop zone === */}
      {phase === "idle" && (
        <div className="max-w-2xl mx-auto px-4 py-12">
          <div className="text-center mb-10">
            <h1 className="text-3xl font-black mb-2">Auto Clean</h1>
            <p className="text-gray-400">上傳短影片，自動移除贅字、語助詞、重複片段</p>
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("border-orange-500"); }}
            onDragLeave={(e) => { e.currentTarget.classList.remove("border-orange-500"); }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove("border-orange-500");
              const file = e.dataTransfer.files[0];
              if (file) processVideo(file);
            }}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-gray-700 rounded-2xl p-16 text-center cursor-pointer hover:border-orange-500 transition-all"
          >
            <div className="text-5xl text-gray-600 mb-4">+</div>
            <p className="text-gray-300 font-medium text-lg">拖放影片到這裡</p>
            <p className="text-sm text-gray-500 mt-2">mp4, mov, webm, mp3, m4a, wav, ogg</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.webm,.avi,.mkv,.mp3,.m4a,.wav,.ogg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) processVideo(file);
              }}
            />
          </div>
        </div>
      )}

      {/* === PROCESSING === */}
      {phase === "processing" && (
        <div className="max-w-2xl mx-auto px-4 py-12 space-y-6">
          {videoPreview && (
            <div className="rounded-2xl overflow-hidden bg-black">
              <video src={videoPreview} className="w-full max-h-[35vh] object-contain" muted />
            </div>
          )}
          <div className="bg-gray-900 rounded-2xl p-8">
            <div className="flex items-center justify-center gap-[3px] h-16 mb-6">
              {Array.from({ length: 40 }).map((_, i) => (
                <div
                  key={i}
                  className="w-[3px] rounded-full bg-gradient-to-t from-orange-500 to-orange-300"
                  style={{
                    height: `${20 + Math.random() * 80}%`,
                    animation: `wave 1.2s ease-in-out ${i * 0.03}s infinite alternate`,
                  }}
                />
              ))}
            </div>
            <p className="text-center text-lg font-bold">{processStep || "處理中..."}</p>
            <p className="text-center text-sm text-gray-400 mt-1">{fileName}</p>
          </div>
        </div>
      )}

      {/* === EDITING: Interactive timeline editor === */}
      {phase === "editing" && (
        <div className="flex flex-col h-screen">
          {/* Video preview */}
          <div className="bg-black flex-shrink-0">
            {videoPreview && (
              <video
                ref={videoRef}
                src={videoPreview}
                controls
                className="w-full max-h-[35vh] object-contain mx-auto"
              />
            )}
            <div className="flex items-center justify-between px-4 py-2 bg-gray-900 text-sm">
              <span className="text-gray-400">
                預估長度 <span className="text-white font-bold">{formatTime(estimatedDuration)}</span>
              </span>
              <div className="flex gap-2">
                <button
                  onClick={selectAllSilences}
                  className="px-3 py-1 text-xs bg-gray-800 rounded-full hover:bg-gray-700 transition-colors"
                >
                  選取無聲
                </button>
                <button
                  onClick={selectAllFillers}
                  className="px-3 py-1 text-xs bg-gray-800 rounded-full hover:bg-gray-700 transition-colors"
                >
                  選取語助詞
                </button>
                <button
                  onClick={clearSelections}
                  className="px-3 py-1 text-xs text-orange-400 bg-gray-800 rounded-full hover:bg-gray-700 transition-colors"
                >
                  清除選中
                </button>
              </div>
            </div>
          </div>

          {/* Timeline items */}
          <div className="flex-1 overflow-y-auto bg-gray-950 pb-24">
            <div className="max-w-2xl mx-auto">
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => toggleItem(item.id)}
                  onDoubleClick={() => seekTo(item.start)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-900 transition-colors ${
                    item.selected ? "bg-gray-900/50" : "hover:bg-gray-900/30"
                  }`}
                >
                  {/* Checkbox */}
                  <div className={`w-6 h-6 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
                    item.selected
                      ? "bg-blue-500 border-blue-500"
                      : "border-gray-600"
                  }`}>
                    {item.selected && (
                      <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span className="text-xs text-gray-500 font-mono w-12 flex-shrink-0">
                    {formatTime(item.start)}
                  </span>

                  {/* Content */}
                  {item.type === "silence" ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400 font-bold">
                        無聲
                      </span>
                      <span className="text-sm text-gray-500 line-through">
                        {item.duration.toFixed(2)}s
                      </span>
                    </div>
                  ) : item.type === "filler" ? (
                    <div className="flex items-center gap-2">
                      <span className={`text-sm ${item.selected ? "text-gray-500 line-through" : "text-gray-300"}`}>
                        {item.text}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                        語助詞
                      </span>
                    </div>
                  ) : (
                    <span className={`text-sm ${item.selected ? "text-gray-500 line-through" : "text-white"}`}>
                      {item.text}
                    </span>
                  )}

                  {/* Reason tag (for GPT-detected issues) */}
                  {item.reason && item.type === "phrase" && (
                    <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 ml-auto flex-shrink-0">
                      {item.reason}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Bottom action bar */}
          <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 p-4">
            <div className="max-w-2xl mx-auto flex items-center gap-3">
              <button
                onClick={handleAssemble}
                disabled={selectedCount === 0}
                className={`flex-1 py-3 rounded-xl font-bold text-center transition-colors ${
                  selectedCount > 0
                    ? "bg-blue-500 hover:bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-500 cursor-not-allowed"
                }`}
              >
                確定刪除 (已選 {selectedCount})
              </button>
              <button
                onClick={reset}
                className="px-4 py-3 rounded-xl bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors"
                title="取消"
              >
                X
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === ASSEMBLING === */}
      {phase === "assembling" && (
        <div className="max-w-2xl mx-auto px-4 py-12">
          <div className="bg-gray-900 rounded-2xl p-10 text-center">
            <div className="w-12 h-12 mx-auto mb-6 border-3 border-orange-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-lg font-bold">組裝影片中...</p>
            <p className="text-sm text-gray-400 mt-2">移除 {selectedCount} 個片段</p>
          </div>
        </div>
      )}

      {/* === DONE === */}
      {phase === "done" && result && (
        <div className="max-w-2xl mx-auto px-4 py-12 space-y-6">
          <div className="rounded-2xl overflow-hidden bg-black">
            <video src={result.videoPath} controls className="w-full max-h-[50vh] object-contain" />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-900 rounded-xl p-4 text-center">
              <p className="text-2xl font-black">{Math.round(result.originalDuration)}s</p>
              <p className="text-xs text-gray-500 mt-1">原始長度</p>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 text-center">
              <p className="text-2xl font-black text-orange-400">{Math.round(result.cleanDuration)}s</p>
              <p className="text-xs text-gray-500 mt-1">精簡後</p>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 text-center">
              <p className="text-2xl font-black text-red-400">{result.removedCount}</p>
              <p className="text-xs text-gray-500 mt-1">移除片段</p>
            </div>
          </div>
          <div className="flex gap-3">
            <a href={result.videoPath} download="clean.mp4"
              className="flex-1 py-3 text-center font-bold bg-orange-500 rounded-xl hover:bg-orange-600 transition-colors">
              下載影片 MP4
            </a>
            <a href={result.srtPath} download="clean.srt"
              className="flex-1 py-3 text-center font-bold bg-gray-800 rounded-xl hover:bg-gray-700 transition-colors">
              下載字幕 SRT
            </a>
          </div>
          <button onClick={reset}
            className="w-full py-3 text-center font-bold text-gray-400 border border-gray-800 rounded-xl hover:border-gray-600 transition-colors">
            處理另一支影片
          </button>
        </div>
      )}

      {/* === ERROR === */}
      {phase === "error" && (
        <div className="max-w-2xl mx-auto px-4 py-12 space-y-4">
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-6 text-center">
            <p className="text-red-400 font-bold mb-2">處理失敗</p>
            <p className="text-sm text-red-300/70">{error}</p>
          </div>
          <button onClick={reset}
            className="w-full py-3 text-center font-bold text-orange-400 border border-orange-500/30 rounded-xl hover:bg-orange-500/10 transition-colors">
            重新嘗試
          </button>
        </div>
      )}

      <style jsx>{`
        @keyframes wave {
          0% { transform: scaleY(0.3); }
          100% { transform: scaleY(1); }
        }
      `}</style>
    </main>
  );
}
