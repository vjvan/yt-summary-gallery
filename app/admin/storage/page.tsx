"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface VideoFile {
  file: string;
  video_id: string;
  bytes: number;
  size_display: string;
  title: string | null;
  source: string | null;
  url: string | null;
  duration_display: string | null;
  public_url: string;
}

interface Resp {
  files: VideoFile[];
  total_bytes: number;
  total_display: string;
  count: number;
}

export default function StoragePage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/storage/videos");
    const d = await r.json();
    setData(d);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleDelete(videoId: string, title: string | null, sizeDisplay: string) {
    if (!confirm(`確定刪除 ${title || videoId} (${sizeDisplay}) 的本機 mp4? 之後該卡會自動 fallback 回 iframe + overlay 模式。`)) return;
    setDeleting(videoId);
    try {
      await fetch(`/api/storage/videos/${videoId}`, { method: "DELETE" });
      await refresh();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black text-gray-900">影片磁碟用量</h1>
            <p className="text-sm text-gray-500 mt-1">
              管理 C 路徑(下載 mp4 取得原生 player)留下的 mp4 檔。刪除後該卡自動 fallback 回 A 路徑。
            </p>
          </div>
          <Link href="/" className="text-sm text-orange-500 hover:underline">
            ← 回到 Gallery
          </Link>
        </div>

        {loading ? (
          <p className="text-gray-400">載入中...</p>
        ) : !data || data.count === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <p className="text-gray-400 mb-2">沒有任何下載到本機的 mp4</p>
            <p className="text-xs text-gray-400">
              在卡片詳情頁按「升級成原生 player(下載 mp4)」就會出現在這裡。
            </p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5 flex items-center justify-between">
              <div>
                <div className="text-sm text-gray-500">總用量</div>
                <div className="text-2xl font-black text-gray-900">{data.total_display}</div>
                <div className="text-xs text-gray-400 mt-1">{data.count} 個檔案</div>
              </div>
              <button
                onClick={refresh}
                className="px-3 py-2 text-sm font-bold text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                重新整理
              </button>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left text-xs font-bold text-gray-500 uppercase tracking-wider px-5 py-3">
                      標題 / 來源
                    </th>
                    <th className="text-right text-xs font-bold text-gray-500 uppercase tracking-wider px-5 py-3">
                      大小
                    </th>
                    <th className="text-right text-xs font-bold text-gray-500 uppercase tracking-wider px-5 py-3">
                      長度
                    </th>
                    <th className="text-right text-xs font-bold text-gray-500 uppercase tracking-wider px-5 py-3">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.files.map((f) => (
                    <tr key={f.video_id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-5 py-4">
                        <div className="font-bold text-gray-900 text-sm">
                          {f.title || f.video_id}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5 truncate max-w-md">
                          {f.source && (
                            <span className="inline-block bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded mr-2 font-bold uppercase text-[10px]">
                              {f.source}
                            </span>
                          )}
                          {f.url || f.file}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-right font-mono text-sm text-gray-700">
                        {f.size_display}
                      </td>
                      <td className="px-5 py-4 text-right font-mono text-sm text-gray-500">
                        {f.duration_display || "—"}
                      </td>
                      <td className="px-5 py-4 text-right">
                        <Link
                          href={`/card/${f.video_id}`}
                          className="text-xs font-bold text-orange-600 hover:underline mr-3"
                        >
                          打開
                        </Link>
                        <button
                          onClick={() => handleDelete(f.video_id, f.title, f.size_display)}
                          disabled={deleting === f.video_id}
                          className="text-xs font-bold text-red-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {deleting === f.video_id ? "刪除中..." : "刪除"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
