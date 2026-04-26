"use client";

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

        <div className="mb-12">
          <GenerateForm onGenerated={fetchItems} />
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
