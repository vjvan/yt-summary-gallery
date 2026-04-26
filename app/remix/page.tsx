"use client";

import { useCallback, useEffect, useState } from "react";
import SingleVideoForm from "@/components/SingleVideoForm";
import RemixForm from "@/components/RemixForm";
import ProjectGrid from "@/components/ProjectGrid";

type Tab = "highlight" | "merge";

export default function RemixPage() {
  const [tab, setTab] = useState<Tab>("highlight");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    try {
      const resp = await fetch("/api/projects");
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

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-black text-gray-900 mb-2">
            Short Video Remix
          </h1>
          <p className="text-gray-500">
            AI-powered highlight extraction and video editing
          </p>
        </div>

        {/* Tab switch */}
        <div className="flex justify-center gap-1 mb-10">
          <button
            onClick={() => setTab("highlight")}
            className={`px-6 py-2.5 rounded-full text-sm font-bold transition-colors ${
              tab === "highlight"
                ? "bg-orange-500 text-white"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            Highlight Reel
          </button>
          <button
            onClick={() => setTab("merge")}
            className={`px-6 py-2.5 rounded-full text-sm font-bold transition-colors ${
              tab === "merge"
                ? "bg-orange-500 text-white"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            Multi-Clip Merge
          </button>
        </div>

        {/* Form */}
        <div className="mb-12">
          {tab === "highlight" ? (
            <SingleVideoForm onGenerated={fetchItems} />
          ) : (
            <RemixForm onGenerated={fetchItems} />
          )}
        </div>

        {/* Project grid */}
        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading...</div>
        ) : (
          <ProjectGrid
            items={items}
            onDelete={async (id) => {
              await fetch(`/api/projects/${id}`, { method: "DELETE" });
              fetchItems();
            }}
          />
        )}
      </div>
    </main>
  );
}
