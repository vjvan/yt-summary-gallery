"use client";

/**
 * 詳情頁可點擊版時間軸。讀 highlights[] 渲染為 vertical list,點任一筆呼父元件
 * 暴露的 seekTo,讓 YouTube player (或本機 mp4) 跳到該時間。
 *
 * 跟 P4 timeline 圖卡 (PNG) 的內容一致,但這是 HTML 互動版,給螢幕觀看用。
 * IG 發佈仍用 PNG,個人觀看跟學習用這個。
 */

interface Highlight {
  timestamp: number;
  label: string;
  description: string;
}

interface Props {
  highlights: Highlight[];
  onSeek: (seconds: number) => void;
  currentTime?: number;
  durationSec?: number; // 拿來判斷 highlights 是否異常 (全集中在影片開頭 = GPT 萃取錯)
  onRequestRegenerate?: () => void;
}

export default function InteractiveTimeline({
  highlights,
  onSeek,
  currentTime,
  durationSec,
  onRequestRegenerate,
}: Props) {
  if (!highlights || highlights.length === 0) return null;

  // 排序顯示 (DB 內可能亂序,UI 強制按時間升序)
  const sorted = [...highlights].sort((a, b) => a.timestamp - b.timestamp);

  // 偵測異常: 影片長度 > 5 分鐘但 highlights 最大 timestamp < 影片長度的 30% → GPT 當初萃取錯
  const maxTs = sorted[sorted.length - 1]?.timestamp ?? 0;
  const looksBroken =
    typeof durationSec === "number" &&
    durationSec > 300 &&
    maxTs < durationSec * 0.3;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-700 tracking-wider uppercase">時間軸</h3>
        <span className="text-xs text-gray-400">點時間戳跳到該段播放</span>
      </div>

      {looksBroken && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start justify-between gap-3">
          <div className="text-xs text-amber-800 leading-snug">
            <strong>時間戳似乎不準確</strong> — 影片 {formatTime(durationSec || 0)},但 highlights 集中在開頭。
            按右側按鈕讓 GPT 重新萃取。
          </div>
          {onRequestRegenerate && (
            <button
              type="button"
              onClick={onRequestRegenerate}
              className="flex-shrink-0 text-xs font-bold text-amber-900 bg-amber-200 hover:bg-amber-300 px-2.5 py-1 rounded"
            >
              重產時間軸
            </button>
          )}
        </div>
      )}

      <div className="space-y-1">
        {sorted.map((h, i) => {
          const next = sorted[i + 1];
          const isActive =
            typeof currentTime === "number" &&
            currentTime >= h.timestamp &&
            (next ? currentTime < next.timestamp : true);
          return (
            <button
              key={`${h.timestamp}-${i}`}
              type="button"
              onClick={() => onSeek(h.timestamp)}
              title={`點擊跳到 ${formatTime(h.timestamp)} 播放`}
              className={`group w-full flex items-start gap-3 text-left px-3 py-2.5 rounded-lg transition-all cursor-pointer border ${
                isActive
                  ? "bg-orange-50 border-orange-300"
                  : "border-transparent hover:bg-orange-50 hover:border-orange-200"
              }`}
            >
              <span
                className={`font-mono text-sm font-bold flex-shrink-0 mt-0.5 px-2 py-0.5 rounded transition-colors ${
                  isActive
                    ? "bg-orange-500 text-white"
                    : "bg-gray-100 text-gray-600 group-hover:bg-orange-200 group-hover:text-orange-800"
                }`}
                style={{ minWidth: 64, textAlign: "center" }}
              >
                ▶ {formatTime(h.timestamp)}
              </span>
              <span className="flex-1">
                <span className={`block font-bold text-sm ${isActive ? "text-orange-900" : "text-gray-800"}`}>
                  {h.label}
                </span>
                <span className="block text-xs text-gray-500 mt-0.5 leading-snug">
                  {h.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
