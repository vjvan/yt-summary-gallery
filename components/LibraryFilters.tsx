"use client";

import { useMemo } from "react";

export type SourceFilter = "all" | "video" | "youtube" | "podcast";
export type StatusFilter = "all" | "done";

export interface LibraryItem {
  id: string;
  source: string;
  is_video?: number;
  status: string;
  title: string | null;
  channel: string | null;
  summary: { tags?: string[] } | null;
}

export interface FilterState {
  query: string;
  source: SourceFilter;
  status: StatusFilter;
  activeTag: string | null;
}

export const INITIAL_FILTERS: FilterState = {
  query: "",
  source: "all",
  status: "done",
  activeTag: null,
};

/**
 * 是否符合 source filter:
 *  - video : 任何能看到影片的(本機影片上傳 / yt-dlp 下載 / YouTube)
 *  - youtube : 只看 YouTube transcript 模式
 *  - podcast : 只看純音訊
 */
function matchesSource(item: LibraryItem, filter: SourceFilter): boolean {
  if (filter === "all") return true;
  if (filter === "video") {
    return item.source === "video" || item.source === "video-url" || item.source === "youtube";
  }
  if (filter === "youtube") return item.source === "youtube";
  if (filter === "podcast") return item.source === "podcast";
  return true;
}

export function applyFilters<T extends LibraryItem>(items: T[], f: FilterState): T[] {
  const q = f.query.trim().toLowerCase();
  return items.filter((item) => {
    if (f.status === "done" && item.status !== "done") return false;
    if (!matchesSource(item, f.source)) return false;
    if (f.activeTag) {
      const tags = item.summary?.tags || [];
      if (!tags.includes(f.activeTag)) return false;
    }
    if (q) {
      const haystack = [
        item.title || "",
        item.channel || "",
        ...(item.summary?.tags || []),
      ].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export default function LibraryFilters({
  items,
  filters,
  onChange,
  totalAfter,
}: {
  items: LibraryItem[];
  filters: FilterState;
  onChange: (f: FilterState) => void;
  totalAfter: number;
}) {
  // 聚合 tag 並按出現頻率排序,取 top 12
  const popularTags = useMemo(() => {
    const counter = new Map<string, number>();
    for (const it of items) {
      for (const t of it.summary?.tags || []) {
        counter.set(t, (counter.get(t) || 0) + 1);
      }
    }
    return Array.from(counter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
  }, [items]);

  const sourceOptions: { key: SourceFilter; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "video", label: "影片" },
    { key: "youtube", label: "YouTube" },
    { key: "podcast", label: "Podcast" },
  ];

  return (
    <div className="space-y-4 mb-8">
      {/* 搜尋 + source 切換 */}
      <div className="flex flex-col md:flex-row gap-3">
        <div className="flex-1 relative">
          <input
            type="text"
            value={filters.query}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
            placeholder="搜尋標題、來源、標籤..."
            className="w-full px-4 py-2.5 pr-32 text-sm border-2 border-gray-200 rounded-lg focus:border-orange-400 focus:outline-none transition-colors"
          />
          <a
            href={`/search${filters.query ? `?q=${encodeURIComponent(filters.query)}` : ""}`}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-2.5 py-1 bg-orange-50 text-orange-600 hover:bg-orange-100 rounded-md font-bold transition-colors"
            title="搜尋影片內所有逐字稿內容"
          >
            搜內容 &rarr;
          </a>
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {sourceOptions.map((opt) => (
            <button
              key={opt.key}
              onClick={() => onChange({ ...filters, source: opt.key })}
              className={`px-4 py-2 rounded-md text-sm font-bold transition-colors ${
                filters.source === opt.key
                  ? "bg-white text-orange-600 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 熱門 tag chips */}
      {popularTags.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-gray-400 font-bold uppercase tracking-wider mr-1">
            標籤
          </span>
          {popularTags.map(([tag, count]) => {
            const active = filters.activeTag === tag;
            return (
              <button
                key={tag}
                onClick={() =>
                  onChange({ ...filters, activeTag: active ? null : tag })
                }
                className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                  active
                    ? "bg-orange-500 text-white border-orange-500"
                    : "border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600"
                }`}
              >
                {tag} <span className="opacity-60">{count}</span>
              </button>
            );
          })}
          {filters.activeTag && (
            <button
              onClick={() => onChange({ ...filters, activeTag: null })}
              className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600"
            >
              清除標籤
            </button>
          )}
        </div>
      )}

      {/* 狀態切換 + counter */}
      <div className="flex justify-between items-center text-sm">
        <label className="flex items-center gap-2 text-gray-500">
          <input
            type="checkbox"
            checked={filters.status === "all"}
            onChange={(e) =>
              onChange({ ...filters, status: e.target.checked ? "all" : "done" })
            }
            className="accent-orange-500"
          />
          顯示處理中 / 失敗的紀錄
        </label>
        <span className="text-gray-400">
          顯示 {totalAfter} / 共 {items.length} 筆
        </span>
      </div>
    </div>
  );
}
