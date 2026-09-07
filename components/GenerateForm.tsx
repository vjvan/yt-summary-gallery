"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { libraryGenerationState } from "@/lib/library-generation-state";

export default function GenerateForm({
  onGenerated,
}: {
  onGenerated: () => void;
}) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "processing" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [autoBurn, setAutoBurn] = useState(false);
  const [autoBurnTrack, setAutoBurnTrack] = useState<"bi" | "zh" | "en">("bi");
  const fileRef = useRef<HTMLInputElement>(null);

  const [resultId, setResultId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAbort = useRef<AbortController | null>(null);
  const pollGeneration = useRef(0);
  const generatedCallback = useRef(onGenerated);
  generatedCallback.current = onGenerated;

  const stopPolling = useCallback(() => {
    pollGeneration.current += 1;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    pollAbort.current?.abort();
  }, []);

  const pollForCompletion = useCallback((id: string) => {
    stopPolling();
    const generation = pollGeneration.current;
    setResultId(id);
    setStatus("processing");
    let errors = 0;
    let checks = 0;
    const check = async () => {
      const controller = new AbortController();
      pollAbort.current = controller;
      const timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await fetch(`/api/summaries/${encodeURIComponent(id)}`, {signal: controller.signal, cache: "no-store"});
        if (!response.ok) throw new Error("無法取得工作進度");
        const item = await response.json();
        if (generation !== pollGeneration.current) return;
        errors = 0;
        checks += 1;
        const next = libraryGenerationState(item);
        setStatus(next.status);
        setMessage(next.message);
        if (item.summary || !next.keepPolling || checks % 4 === 0) generatedCallback.current();
        if (!next.keepPolling) {
          sessionStorage.removeItem("yt-library-active-job");
          return;
        }
        // Single request at a time; no five-minute silent timeout. The server job
        // survives page navigation and its id can be re-opened from the library.
        pollTimer.current = setTimeout(check, 4000);
      } catch {
        if (generation !== pollGeneration.current) return;
        errors += 1;
        if (errors >= 3) {
          setStatus("error");
          setMessage("暫時無法讀取進度，不代表字幕工作失敗。請確認本機服務開啟，再按下方「重新查看進度」。");
        } else pollTimer.current = setTimeout(check, 3000 * errors);
      } finally { clearTimeout(timeout); }
    };
    sessionStorage.setItem("yt-library-active-job", id);
    void check();
  }, [stopPolling]);

  useEffect(() => {
    const preset = new URL(window.location.href).searchParams.get("url");
    if (preset && preset.length <= 2048 && /^https?:\/\//i.test(preset)) setUrl(preset);
    const pendingId = sessionStorage.getItem("yt-library-active-job");
    if (pendingId && /^[a-zA-Z0-9_-]{1,80}$/.test(pendingId)) pollForCompletion(pendingId);
    return stopPolling;
  }, [pollForCompletion, stopPolling]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setStatus("processing");
    setMessage("正在處理中...");

    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setStatus("error");
        setMessage(data.error || "發生錯誤");
        return;
      }

      if (typeof data.id !== "string") throw new Error("缺少工作 ID");
      onGenerated();
      pollForCompletion(data.id);
    } catch {
      setStatus("error");
      setMessage("網路錯誤");
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus("processing");
    setMessage(`上傳中: ${file.name}...`);

    try {
      // 串流上傳:body 直接是檔案,瀏覽器邊讀邊送、server 邊收邊寫盤。
      // 不走 FormData — req.formData() 會把整個檔案讀進記憶體,GB 級影片會炸。
      const title = file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
      const autoburnParam = autoBurn ? `&autoburn=${autoBurnTrack}` : "";
      const resp = await fetch(
        `/api/upload?filename=${encodeURIComponent(file.name)}&title=${encodeURIComponent(title)}${autoburnParam}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        }
      );

      const data = await resp.json();

      if (!resp.ok) {
        setStatus("error");
        setMessage(data.error || "上傳失敗");
        return;
      }

      if (typeof data.id !== "string") throw new Error("缺少工作 ID");
      onGenerated();
      pollForCompletion(data.id);
    } catch {
      setStatus("error");
      setMessage("上傳失敗");
    }

    // Reset file input
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="w-full max-w-3xl mx-auto">
      <form onSubmit={handleSubmit}>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="YouTube 或 Podcast 影片連結"
            placeholder="貼上 YouTube 或 Podcast 連結..."
            className="min-w-0 flex-1 px-5 py-4 text-lg border-2 border-gray-200 rounded-xl focus:border-orange-400 focus:outline-none transition-colors"
            disabled={status === "processing"}
          />
          <button
            type="submit"
            disabled={status === "processing" || !url.trim()}
            className="px-8 py-4 text-lg font-bold text-white bg-orange-500 rounded-xl hover:bg-orange-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {status === "processing" ? "處理中..." : "產生摘要與完整字幕"}
          </button>
        </div>
      </form>
      <p className="mt-3 text-xs leading-relaxed text-gray-500">YouTube 有原文字幕時，優先讀字幕產生摘要與整片翻譯，不必先下載音訊。完成後從影片詳情觀看、下載 SRT；要燒進 MP4，還需要可合法取得的原始影片檔案。</p>
      {resultId && <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <Link href={`/card/${encodeURIComponent(resultId)}`} className="rounded-lg border border-orange-300 px-3 py-2 font-bold text-orange-700">查看摘要、字幕與影片下載 →</Link>
        {status === "error" && <button type="button" onClick={() => pollForCompletion(resultId)} className="underline underline-offset-4">重新查看進度</button>}
      </div>}

      {/* Upload button */}
      <div className="flex items-center gap-3 mt-3">
        <div className="flex-1 h-px bg-gray-200" />
        <span className="text-xs text-gray-400">或</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      <label className="mt-3 flex items-center justify-center gap-2 px-5 py-3 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-orange-400 hover:bg-orange-50 transition-colors">
        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <span className="text-sm text-gray-500 font-bold">上傳音訊或影片 (mp3, m4a, wav, mp4, mov, mkv, webm)</span>
        <input
          ref={fileRef}
          type="file"
          accept=".mp3,.m4a,.wav,.ogg,.opus,.aac,.flac,.mp4,.mov,.mkv,.webm,.m4v,.avi,audio/*,video/*"
          onChange={handleFileUpload}
          disabled={status === "processing"}
          className="hidden"
        />
      </label>

      {/* 影片完成後自動燒錄字幕(對音訊檔無效) */}
      <div className="mt-2 flex items-center justify-center gap-2 text-sm text-gray-500">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoBurn}
            onChange={(e) => setAutoBurn(e.target.checked)}
            disabled={status === "processing"}
            className="accent-purple-500"
          />
          上傳影片完成後自動燒錄字幕
        </label>
        {autoBurn && (
          <select
            value={autoBurnTrack}
            onChange={(e) => setAutoBurnTrack(e.target.value as "bi" | "zh" | "en")}
            disabled={status === "processing"}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm text-gray-600"
          >
            <option value="bi">雙語(上中下英)</option>
            <option value="zh">只燒中文</option>
            <option value="en">只燒英文</option>
          </select>
        )}
        {autoBurn && <span className="text-xs text-gray-400">(限影片檔,入庫後背景燒錄)</span>}
      </div>

      {message && (
        <p role="status" aria-live="polite"
          className={`mt-3 break-words text-sm text-center ${
            status === "error"
              ? "text-red-500"
              : status === "done"
              ? "text-green-600"
              : "text-gray-500"
          }`}
        >
          {status === "processing" && (
            <span className="inline-block w-4 h-4 mr-2 border-2 border-orange-400 border-t-transparent rounded-full animate-spin align-middle" />
          )}
          {message}
        </p>
      )}
    </div>
  );
}
