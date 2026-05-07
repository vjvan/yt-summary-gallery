"use client";

/**
 * Layer 7 護城河 + funnel 入口頁: 允雷推薦影片庫公開展示。
 *
 * 不需登入即可看,訪客看到「允雷選的影片+萃取」→ 體會品味 → 訂閱動機。
 * 每張卡的視覺已含浮水印 (Layer 8),IG / Threads 自然分享也帶推廣。
 */

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface FeaturedItem {
  id: string;
  video_id: string;
  source: string;
  url: string;
  title: string;
  channel: string;
  duration_display: string;
  thumbnail_url: string | null;
  card_paths: string[] | null;
  slide_count: number;
  featured_note: string | null;
  one_liner: string | null;
  tags: string[];
  video_genre: string | null;
  created_at: string;
}

export default function FeaturedPage() {
  const [items, setItems] = useState<FeaturedItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    try {
      const r = await fetch("/api/featured");
      const d = await r.json();
      setItems(d.items || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-orange-50/40 to-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="text-center mb-12">
          <div className="inline-block px-4 py-1.5 rounded-full bg-orange-100 text-orange-700 text-xs font-bold tracking-wider mb-4">
            CURATED · 允雷的選片
          </div>
          <h1 className="text-4xl sm:text-5xl font-black text-gray-900 mb-3 leading-tight">
            5 分鐘吸收一支 1 小時的影片
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed">
            這是我自己用的 AI 影片知識萃取工具。
            <br />
            底下是我精選的影片 + 自動產的學習卡。
          </p>
        </div>

        {/* Featured items */}
        {loading ? (
          <div className="text-center py-20 text-gray-400">載入中...</div>
        ) : items.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            還沒有推薦影片。允雷會在後台慢慢挑。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
            {items.map((item) => (
              <article
                key={item.id}
                className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden hover:shadow-xl transition-shadow"
              >
                {item.card_paths && item.card_paths[0] && (
                  <div className="relative w-full aspect-[4/5] bg-gray-50">
                    <Image
                      src={item.card_paths[0]}
                      alt={item.title}
                      width={1080}
                      height={1350}
                      className="w-full h-full object-contain"
                      unoptimized
                    />
                    {item.slide_count > 1 && (
                      <span className="absolute top-3 right-3 bg-black/60 text-white text-xs font-bold px-2 py-1 rounded-md backdrop-blur-sm">
                        {item.slide_count} 卡
                      </span>
                    )}
                  </div>
                )}
                <div className="p-5">
                  <div className="flex items-center gap-2 mb-2 text-xs text-gray-400">
                    {item.video_genre && (
                      <span className="uppercase tracking-wider font-bold">{item.video_genre}</span>
                    )}
                    <span>·</span>
                    <span>{item.channel}</span>
                    <span>·</span>
                    <span>{item.duration_display}</span>
                  </div>
                  <h2 className="text-xl font-black text-gray-900 mb-2 leading-tight">
                    {item.title}
                  </h2>
                  {item.one_liner && (
                    <p className="text-sm text-gray-600 leading-relaxed mb-3">{item.one_liner}</p>
                  )}
                  {item.featured_note && (
                    <div className="bg-orange-50 border-l-4 border-orange-400 px-3 py-2 mb-3 rounded-r">
                      <div className="text-xs font-bold text-orange-700 mb-0.5">允雷的話</div>
                      <p className="text-sm text-gray-800 leading-snug">{item.featured_note}</p>
                    </div>
                  )}
                  {item.tags.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {item.tags.slice(0, 4).map((t) => (
                        <span
                          key={t}
                          className="text-xs px-2 py-0.5 rounded-full border border-gray-200 text-gray-600"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        {/* CTA: 訂閱解鎖完整工具 */}
        <div className="bg-gradient-to-br from-orange-500 to-orange-600 text-white rounded-2xl p-10 text-center shadow-xl">
          <h2 className="text-3xl font-black mb-3">想要自己的知識萃取庫?</h2>
          <p className="text-lg opacity-95 mb-6 max-w-xl mx-auto leading-relaxed">
            完整工具 + 跨影片搜尋 + 個人筆記 + 9 種卡片智能布局,
            <br />
            是 P2P AI Lab Premium 訂閱者的專屬武器。
          </p>
          <Link
            href="https://vjvan.com"
            className="inline-block bg-white text-orange-600 px-8 py-3 rounded-lg font-black hover:bg-gray-50 transition-colors"
          >
            了解 P2P AI Lab →
          </Link>
        </div>

        {/* Footer */}
        <div className="text-center mt-12 text-xs text-gray-400">
          Curated by 允雷 · vjvan.com · P2P AI Lab
        </div>
      </div>
    </main>
  );
}
