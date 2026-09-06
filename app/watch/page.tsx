import type { Metadata } from "next";
import WatchClient from "@/components/WatchClient";

export const metadata: Metadata = {
  title: "近即時字幕 · 創作者字幕翻譯庫",
  description: "以原文字幕、專業術語與語境翻譯，同步觀看 YouTube。",
};

export default async function WatchPage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string; url?: string }>;
}) {
  const query = await searchParams;
  return <WatchClient demo={query.demo === "1"} initialUrl={query.url || ""} />;
}
