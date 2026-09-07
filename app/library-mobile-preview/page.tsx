import type { Metadata } from 'next';
export const metadata: Metadata = { title: '影片庫 · 手機版互動預覽', robots: { index: false, follow: false } };
export default function LibraryMobilePreview() {
  return <main style={{ background: '#e9e9e7', minHeight: '100vh', padding: '28px 16px', display: 'grid', justifyItems: 'center', gap: 12 }}>
    <p style={{ fontSize: 14 }}>影片庫手機版互動預覽 · 440 × 956 · 使用真實本機資料，按下產生才開始處理</p>
    <div style={{ width: 464, background: '#1d1d1f', borderRadius: 54, padding: 12, boxShadow: '0 20px 60px #0002' }}>
      <div style={{ borderRadius: 43, overflow: 'hidden', background: '#fff' }}>
        <div style={{ height: 52, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 24px', fontSize: 12 }}>
          <span>9:41</span><span style={{ display: 'inline-block', width: 125, height: 34, borderRadius: 24, background: '#000' }} aria-label="Dynamic Island" /><span>▮▮ 100%</span>
        </div>
        <iframe title="手機版影片字幕翻譯庫" src="/" style={{ width: 440, height: 858, border: 0, display: 'block' }} />
        <div style={{ height: 46, padding: 8, background: '#f4f4f5', textAlign: 'center', fontSize: 11 }}>AA　 localhost /　↻<div style={{ width: 125, height: 4, background: '#222', borderRadius: 4, margin: '8px auto 0' }} /></div>
      </div>
    </div>
  </main>;
}
