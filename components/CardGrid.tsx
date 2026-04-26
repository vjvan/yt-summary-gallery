"use client";

import Image from "next/image";
import Link from "next/link";

interface CardItem {
  id: string;
  video_id: string;
  title: string;
  channel: string;
  duration_display: string;
  thumbnail_url: string;
  source: string;
  is_video?: number;
  card_paths: string[] | null;
  status: string;
  summary: {
    title_display: string;
    tags: string[];
  } | null;
  created_at: string;
}

function sourceBadge(source: string) {
  switch (source) {
    case "youtube": return { label: "YouTube", bg: "bg-red-500/80" };
    case "video-url": return { label: "影片連結", bg: "bg-blue-500/80" };
    case "video": return { label: "影片", bg: "bg-blue-500/80" };
    case "podcast": return { label: "Podcast", bg: "bg-purple-500/80" };
    default: return { label: source || "Other", bg: "bg-gray-500/80" };
  }
}

export default function CardGrid({
  items,
  onDelete,
}: {
  items: CardItem[];
  onDelete?: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="text-center py-20 text-gray-400">
        <p className="text-lg">還沒有摘要圖卡</p>
        <p className="text-sm mt-2">貼上 YouTube 連結開始產生</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {items.map((item) => (
        <Link
          key={item.id}
          href={`/card/${item.video_id}`}
          className="group relative block bg-white rounded-xl border border-gray-100 overflow-hidden hover:shadow-lg transition-shadow"
        >
          {onDelete && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirm("確定要刪除這張摘要圖卡?")) onDelete(item.id);
              }}
              className="absolute top-2 right-2 z-10 bg-black/50 text-white rounded-full w-7 h-7 flex items-center justify-center text-sm hover:bg-red-500 transition-colors shadow opacity-0 group-hover:opacity-100"
              title="刪除"
            >
              X
            </button>
          )}
          {item.status === "done" && item.card_paths?.length ? (
            <div className="aspect-[4/5] relative overflow-hidden">
              <Image
                src={item.card_paths[0]}
                alt={item.title || ""}
                fill
                className="object-cover group-hover:scale-[1.02] transition-transform"
              />
              <div className="absolute top-3 right-3 flex gap-1.5">
                {(() => {
                  const b = sourceBadge(item.source);
                  return (
                    <span className={`text-white text-xs px-2 py-1 rounded-full font-bold ${b.bg}`}>
                      {b.label}
                    </span>
                  );
                })()}
                <span className="bg-black/60 text-white text-xs px-2 py-1 rounded-full font-bold">
                  {item.card_paths.length} 頁
                </span>
              </div>
            </div>
          ) : (
            <div className="aspect-[4/5] bg-gray-50 flex items-center justify-center">
              {item.status === "processing" ? (
                <div className="text-center">
                  <div className="w-8 h-8 mx-auto mb-3 border-3 border-orange-400 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-gray-400">處理中...</p>
                </div>
              ) : (
                <p className="text-sm text-red-400">處理失敗</p>
              )}
            </div>
          )}
          <div className="p-4">
            <p className="font-bold text-sm text-gray-800 line-clamp-2">
              {item.summary?.title_display || item.title}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {item.channel}
              {item.duration_display ? ` / ${item.duration_display}` : ""}
            </p>
            {item.summary?.tags && (
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {item.summary.tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    className="text-xs px-2 py-0.5 rounded-full border border-orange-300 text-orange-600"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
