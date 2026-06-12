"use client";

import { useRef, useState } from "react";

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

  function pollForCompletion(id: string) {
    setMessage("轉錄與分析中，請稍候...");
    const poll = setInterval(async () => {
      try {
        const check = await fetch(`/api/summaries/${id}`);
        const result = await check.json();
        if (result.status === "done") {
          clearInterval(poll);
          setStatus("done");
          setMessage("完成!");
          setUrl("");
          onGenerated();
        } else if (result.status === "error") {
          clearInterval(poll);
          setStatus("error");
          setMessage(result.error || "處理失敗");
        }
      } catch {
        // keep polling
      }
    }, 3000);
    setTimeout(() => clearInterval(poll), 300000);
  }

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

      if (data.status === "done") {
        setStatus("done");
        setMessage("已完成!");
        setUrl("");
        onGenerated();
        return;
      }

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

      if (data.status === "done") {
        setStatus("done");
        setMessage("已完成!");
        onGenerated();
        return;
      }

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
        <div className="flex gap-3">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="貼上 YouTube 或 Podcast 連結..."
            className="flex-1 px-5 py-4 text-lg border-2 border-gray-200 rounded-xl focus:border-orange-400 focus:outline-none transition-colors"
            disabled={status === "processing"}
          />
          <button
            type="submit"
            disabled={status === "processing" || !url.trim()}
            className="px-8 py-4 text-lg font-bold text-white bg-orange-500 rounded-xl hover:bg-orange-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {status === "processing" ? "處理中..." : "產生摘要"}
          </button>
        </div>
      </form>

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
          完成後自動燒錄字幕
        </label>
        {autoBurn && (
          <select
            value={autoBurnTrack}
            onChange={(e) => setAutoBurnTrack(e.target.value as "bi" | "zh" | "en")}
            disabled={status === "processing"}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm text-gray-600"
          >
            <option value="bi">雙語(上英下中)</option>
            <option value="zh">只燒中文</option>
            <option value="en">只燒英文</option>
          </select>
        )}
        {autoBurn && <span className="text-xs text-gray-400">(限影片檔,入庫後背景燒錄)</span>}
      </div>

      {message && (
        <p
          className={`mt-3 text-sm text-center ${
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
