"use client";

/**
 * Layer 3 護城河: 個人筆記面板。
 *
 * 顯示某影片的所有 annotation,可加新筆記、刪舊筆記、點筆記跳影片時間。
 * 累積越多 = 學員 switching cost 越高 = 離不開這個工具。
 *
 * 設計刻意「親和」: 加註一定要可以用「當前播放時間」一鍵預填 timestamp。
 */

import { useCallback, useEffect, useState } from "react";

interface Annotation {
  id: number;
  video_id: string;
  timestamp: number;
  body: string;
  created_at: string;
  updated_at: string;
}

interface Props {
  videoId: string;
  currentTime?: number;
  onSeek?: (s: number) => void;
}

export default function AnnotationsPanel({ videoId, currentTime = 0, onSeek }: Props) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addTimestamp, setAddTimestamp] = useState(0);
  const [addBody, setAddBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/annotations?video_id=${encodeURIComponent(videoId)}`);
    const d = await r.json();
    setAnnotations(d.annotations || []);
    setLoading(false);
  }, [videoId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function startAdding() {
    setAddTimestamp(Math.floor(currentTime));
    setAddBody("");
    setAdding(true);
  }

  async function submit() {
    const body = addBody.trim();
    if (!body) return;
    setSubmitting(true);
    try {
      await fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: videoId, timestamp: addTimestamp, body }),
      });
      setAdding(false);
      setAddBody("");
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("刪除這條筆記?")) return;
    await fetch(`/api/annotations/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-700 tracking-wider uppercase">我的筆記</h3>
        {!adding && (
          <button
            type="button"
            onClick={startAdding}
            className="text-xs font-bold text-orange-600 hover:underline"
          >
            + 在 {formatTime(currentTime)} 加註
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-3 p-3 bg-orange-50 border border-orange-200 rounded-lg">
          <div className="flex items-center gap-2 mb-2 text-xs text-gray-600">
            <span>時間戳:</span>
            <input
              type="number"
              min={0}
              value={addTimestamp}
              onChange={(e) => setAddTimestamp(Number(e.target.value) || 0)}
              className="w-20 px-2 py-1 rounded border border-gray-200 text-sm font-mono"
            />
            <span>秒 ({formatTime(addTimestamp)})</span>
            <button
              type="button"
              onClick={() => setAddTimestamp(Math.floor(currentTime))}
              className="ml-auto text-orange-600 hover:underline"
              title="用當前播放時間"
            >
              ↻ 用當前
            </button>
          </div>
          <textarea
            value={addBody}
            onChange={(e) => setAddBody(e.target.value)}
            placeholder="記下你看完這段的想法、要做的事、或一個關鍵字..."
            rows={3}
            maxLength={2000}
            className="w-full px-3 py-2 rounded border border-gray-200 text-sm resize-y"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-gray-400">{addBody.length}/2000</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAdding(false)}
                disabled={submitting}
                className="px-3 py-1 text-xs font-bold text-gray-500 hover:text-gray-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting || !addBody.trim()}
                className="px-3 py-1 text-xs font-bold text-white bg-orange-500 rounded hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "存..." : "存筆記"}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-400">載入中...</p>
      ) : annotations.length === 0 ? (
        <p className="text-xs text-gray-400 leading-relaxed">
          還沒有筆記。看影片時想到什麼就點上面「加註」記下來,日後跨影片搜尋會搜到。
        </p>
      ) : (
        <div className="space-y-2">
          {annotations.map((a) => (
            <div
              key={a.id}
              className="group flex items-start gap-2 p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200"
            >
              <button
                type="button"
                onClick={() => onSeek?.(a.timestamp)}
                className="font-mono text-xs font-bold text-orange-600 hover:underline flex-shrink-0 mt-0.5"
                title="跳到這個時間"
                style={{ minWidth: 50 }}
              >
                [{formatTime(a.timestamp)}]
              </button>
              <p className="flex-1 text-sm text-gray-700 leading-snug whitespace-pre-wrap">{a.body}</p>
              <button
                type="button"
                onClick={() => remove(a.id)}
                className="opacity-0 group-hover:opacity-100 text-xs text-red-500 hover:underline flex-shrink-0"
                title="刪除"
              >
                刪
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTime(s: number): string {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
