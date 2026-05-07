"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import GenerateForm from "@/components/GenerateForm";
import CardGrid from "@/components/CardGrid";
import LibraryFilters, {
  INITIAL_FILTERS,
  applyFilters,
  type FilterState,
  type LibraryItem,
} from "@/components/LibraryFilters";

export default function Home() {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);

  const fetchItems = useCallback(async () => {
    try {
      const resp = await fetch("/api/summaries");
      const data = await resp.json();
      setItems(data.items || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const filtered = useMemo(() => applyFilters(items, filters), [items, filters]);

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-12">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-black text-gray-900 mb-2">
            影片字幕翻譯庫
          </h1>
          <p className="text-gray-500 text-lg">
            貼連結或上傳影片,自動產生雙語字幕、摘要、可下載 SRT
          </p>
        </div>

        <div className="mb-8">
          <GenerateForm onGenerated={fetchItems} />
        </div>

        {/* Layer 6 護城河:三大工作流入口卡 (整套 stack 體驗,單一 feature 易抄整套難抄) */}
        <div className="mb-12 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Link
            href="/"
            className="bg-orange-50 border-2 border-orange-200 rounded-xl p-4 hover:border-orange-400 transition-colors"
          >
            <div className="text-xs font-bold text-orange-600 mb-1 tracking-wider">圖卡萃取</div>
            <div className="text-sm font-bold text-gray-800 mb-1">影片 → 9 種學習卡</div>
            <div className="text-xs text-gray-500 leading-snug">獲取 / 實作 / 記憶 三層覆蓋</div>
          </Link>
          <Link
            href="/remix"
            className="bg-white border-2 border-gray-200 rounded-xl p-4 hover:border-orange-300 hover:bg-orange-50 transition-colors"
          >
            <div className="text-xs font-bold text-gray-600 mb-1 tracking-wider">短影片混剪</div>
            <div className="text-sm font-bold text-gray-800 mb-1">挑 highlights 自動產短片</div>
            <div className="text-xs text-gray-500 leading-snug">為 IG / Threads / YT Shorts 用</div>
          </Link>
          <Link
            href="/clean"
            className="bg-white border-2 border-gray-200 rounded-xl p-4 hover:border-orange-300 hover:bg-orange-50 transition-colors"
          >
            <div className="text-xs font-bold text-gray-600 mb-1 tracking-wider">口播自動剪接</div>
            <div className="text-sm font-bold text-gray-800 mb-1">剪掉停頓 + 燒字幕</div>
            <div className="text-xs text-gray-500 leading-snug">給自己的口播影片用</div>
          </Link>
        </div>

        {loading ? (
          <div className="text-center py-20 text-gray-400">載入中...</div>
        ) : items.length === 0 ? (
          <CardGrid items={[]} />
        ) : (
          <>
            <LibraryFilters
              items={items}
              filters={filters}
              onChange={setFilters}
              totalAfter={filtered.length}
            />
            <CardGrid
              items={filtered as never[]}
              onDelete={async (id) => {
                await fetch(`/api/summaries/${id}`, { method: "DELETE" });
                fetchItems();
              }}
            />
          </>
        )}
      </div>
    </main>
  );
}
