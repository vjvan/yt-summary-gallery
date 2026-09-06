import type { Metadata } from 'next';
import LiveClient from '@/components/LiveClient';
export const metadata: Metadata = { title: 'Discord 直播翻譯台 · 創作者字幕翻譯庫', description: '本機直播聽譯、繁中逐字稿，以及由你確認的英文回覆草稿。' };
export default async function LivePage({ searchParams }: { searchParams: Promise<{ demo?: string; session?: string }> }) {
  const query = await searchParams;
  return <LiveClient demo={query.demo === '1'} initialSession={query.session || ''} />;
}
