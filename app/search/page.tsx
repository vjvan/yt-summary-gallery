"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface SearchHit {
  summary_id: string;
  video_id: string;
  title: string;
  source: string;
  is_video: number;
  thumbnail_url: string | null;
  segment_index: number;
  start: number;
  start_display: string;
  text_en: string;
  text_zh: string | null;
  matched_in: "en" | "zh" | "both";
}

interface TagVideo {
  summary_id: string;
  video_id: string;
  title: string;
  source: string;
  is_video: number;
  matched_tags: string[];
  has_segment_hits: boolean;
}

interface TagAggregate { tag: string; count: number }

interface SearchGroup {
  video_id: string;
  title: string;
  source: string;
  is_video: number;
  matched_tags: string[];   // 命中的 tags(可能為空)
  hits: SearchHit[];        // segment 命中(可能為空,代表只有 tag 命中)
}

function sourceLabel(s: string): { label: string; color: string } {
  switch (s) {
    case "youtube": return { label: "YouTube", color: "bg-red-500" };
    case "video-url": return { label: "影片連結", color: "bg-blue-500" };
    case "video": return { label: "影片", color: "bg-blue-500" };
    case "podcast": return { label: "Podcast", color: "bg-purple-500" };
    default: return { label: s || "Other", color: "bg-gray-500" };
  }
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(qLower, cursor);
    if (idx === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <mark key={idx} className="bg-yellow-200 text-gray-900 px-0.5 rounded-sm">
        {text.slice(idx, idx + query.length)}
      </mark>
    );
    cursor = idx + query.length;
  }
  return <>{parts.map((p, i) => <span key={i}>{p}</span>)}</>;
}

/**
 * 把 hits + tag_videos 合併成 groups。
 * 同一影片若同時有 segment hits 和 tag matched,合併成一個 group。
 */
function buildGroups(hits: SearchHit[], tagVideos: TagVideo[]): SearchGroup[] {
  const map = new Map<string, SearchGroup>();
  for (const h of hits) {
    let g = map.get(h.video_id);
    if (!g) {
      g = {
        video_id: h.video_id, title: h.title, source: h.source,
        is_video: h.is_video, matched_tags: [], hits: [],
      };
      map.set(h.video_id, g);
    }
    g.hits.push(h);
  }
  for (const tv of tagVideos) {
    let g = map.get(tv.video_id);
    if (!g) {
      g = {
        video_id: tv.video_id, title: tv.title, source: tv.source,
        is_video: tv.is_video, matched_tags: tv.matched_tags, hits: [],
      };
      map.set(tv.video_id, g);
    } else {
      g.matched_tags = tv.matched_tags;
    }
  }
  return Array.from(map.values());
}

function SearchInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialQuery = params.get("q") || "";
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [tagAggs, setTagAggs] = useState<TagAggregate[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // 載入熱門 tag chips(獨立於搜尋,每個 query 都用同一份)
  useEffect(() => {
    fetch("/api/tags")
      .then((r) => r.json())
      .then((d: { tags: TagAggregate[] }) => setTagAggs(d.tags || []))
      .catch(() => { /* ignore */ });
  }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setGroups([]);
      setTotalHits(0);
      setHasSearched(false);
      return;
    }
    setLoading(true);
    setSubmittedQuery(q);
    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await resp.json();
      const hits: SearchHit[] = data.hits || [];
      const tagVideos: TagVideo[] = data.tag_videos || [];
      setGroups(buildGroups(hits, tagVideos));
      setTotalHits(hits.length);
      setHasSearched(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialQuery) runSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitQuery(query.trim());
  }

  function submitQuery(q: string) {
    if (!q) return;
    setQuery(q);
    router.replace(`/search?q=${encodeURIComponent(q)}`);
    runSearch(q);
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-10">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">
          &larr; 回到 Gallery
        </Link>
        <h1 className="text-3xl font-black text-gray-900 mt-3 mb-2">
          全文搜尋
        </h1>
        <p className="text-gray-500 mb-6">
          搜尋所有影片的逐字稿(中英雙語)+ 摘要標籤,點命中段落直接跳到該秒。
        </p>

        <form onSubmit={handleSubmit} className="flex gap-3 mb-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="關鍵字,例如 design system / 重混 / iterate / AI設計"
            className="flex-1 px-5 py-3 text-base border-2 border-gray-200 rounded-lg focus:border-orange-400 focus:outline-none transition-colors"
            autoFocus
          />
          <button
            type="submit"
            disabled={loading}
            className="px-6 py-3 font-bold text-white bg-orange-500 hover:bg-orange-600 rounded-lg transition-colors disabled:bg-gray-300"
          >
            {loading ? "搜尋中..." : "搜尋"}
          </button>
        </form>

        {/* 熱門 tag chips */}
        {tagAggs.length > 0 && (
          <div className="flex flex-wrap gap-2 items-center mb-8">
            <span className="text-xs text-gray-400 font-bold uppercase tracking-wider mr-1">
              熱門標籤
            </span>
            {tagAggs.slice(0, 16).map(({ tag, count }) => {
              const active = submittedQuery.toLowerCase() === tag.toLowerCase();
              return (
                <button
                  key={tag}
                  onClick={() => submitQuery(tag)}
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
          </div>
        )}

        {!hasSearched && !loading && (
          <p className="text-center py-12 text-gray-400">輸入關鍵字或點上方標籤開始搜尋</p>
        )}

        {hasSearched && !loading && (
          <p className="text-sm text-gray-500 mb-4">
            找到 <span className="font-bold text-gray-900">{totalHits}</span> 段命中,
            橫跨 <span className="font-bold text-gray-900">{groups.length}</span> 支影片
          </p>
        )}

        <div className="space-y-6">
          {groups.map((g) => (
            <div
              key={g.video_id}
              className="bg-white border border-gray-100 rounded-xl overflow-hidden"
            >
              <div className="px-5 py-3 border-b border-gray-100">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`text-white text-xs px-2 py-0.5 rounded-full font-bold flex-shrink-0 ${sourceLabel(g.source).color}`}
                    >
                      {sourceLabel(g.source).label}
                    </span>
                    <h2 className="font-bold text-gray-900 truncate">{g.title}</h2>
                  </div>
                  <Link
                    href={`/card/${g.video_id}`}
                    className="text-xs text-gray-400 hover:text-orange-500 flex-shrink-0"
                  >
                    打開影片 &rarr;
                  </Link>
                </div>
                {g.matched_tags.length > 0 && (
                  <div className="flex gap-1.5 mt-2 flex-wrap items-center">
                    <span className="text-xs text-gray-400">匹配標籤:</span>
                    {g.matched_tags.map((t) => (
                      <span
                        key={t}
                        className="text-xs px-2 py-0.5 rounded-full border border-orange-300 text-orange-600 bg-orange-50"
                      >
                        <Highlight text={t} query={submittedQuery} />
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {g.hits.length > 0 ? (
                <ul className="divide-y divide-gray-100">
                  {g.hits.map((h) => (
                    <li key={`${g.video_id}-${h.segment_index}`}>
                      <Link
                        href={`/card/${h.video_id}#t=${Math.floor(h.start)}&seg=${h.segment_index}`}
                        className="block px-5 py-3 hover:bg-orange-50 transition-colors group"
                      >
                        <div className="flex gap-3">
                          <span className="text-xs font-mono text-orange-600 font-bold w-12 flex-shrink-0 pt-0.5">
                            {h.start_display}
                          </span>
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="text-sm text-gray-800">
                              <Highlight text={h.text_en} query={submittedQuery} />
                            </p>
                            {h.text_zh && (
                              <p className="text-sm text-gray-500">
                                <Highlight text={h.text_zh} query={submittedQuery} />
                              </p>
                            )}
                          </div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-3 text-sm text-gray-400">
                  逐字稿沒有直接命中,但摘要標籤吻合(點上方「打開影片」查看)
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-gray-50" />}>
      <SearchInner />
    </Suspense>
  );
}
