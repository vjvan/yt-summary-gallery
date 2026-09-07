import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "社群學習卡 · 手機版互動預覽",
  robots: { index: false, follow: false },
};

export default async function CardMobilePreview({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id = "" } = await searchParams;
  const safeId = /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : "";
  const src = safeId ? `/card/${safeId}` : "/";

  return (
    <main className="grid min-h-screen justify-items-center gap-3 bg-[#e9e9e7] px-4 py-7">
      <p className="text-sm text-gray-700">社群學習卡手機版互動預覽 · 440 × 956</p>
      <div className="w-[464px] max-w-full rounded-[54px] bg-[#1d1d1f] p-3 shadow-2xl">
        <div className="overflow-hidden rounded-[43px] bg-white">
          <div className="flex h-[52px] items-center justify-between px-6 text-xs">
            <span>9:41</span>
            <span aria-label="Dynamic Island" className="inline-block h-[34px] w-[125px] rounded-3xl bg-black" />
            <span>▮▮ 100%</span>
          </div>
          <iframe title="手機版社群學習卡" src={src} className="block h-[858px] w-[440px] max-w-full border-0" />
          <div className="h-[46px] bg-zinc-100 p-2 text-center text-[11px]">
            AA　 localhost /　↻
            <div className="mx-auto mt-2 h-1 w-[125px] rounded bg-zinc-800" />
          </div>
        </div>
      </div>
    </main>
  );
}
