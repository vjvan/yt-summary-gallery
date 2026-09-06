import type { Metadata } from 'next';
export const metadata: Metadata = { title: '直播翻譯台 · 手機版預覽', robots: { index: false, follow: false } };
export default function LiveMobilePreview() {
  return <main style={{ background: '#e9e9e7', minHeight: '100vh', padding: '24px 0', overflowX: 'auto' }}>
    <div style={{ minWidth: 488, display: 'grid', justifyItems: 'center', gap: 12 }}>
      <p style={{ fontSize: 14, textAlign: 'center', padding: '0 20px' }}>iPhone 16 Pro Max · 440 × 956 螢幕 · 示範資料，不呼叫 API</p>
      <div style={{ width: 464, padding: 12, boxSizing: 'border-box', borderRadius: 38, background: '#1d1d1f', boxShadow: '0 20px 60px #0002' }}>
        <div data-live-mobile-screen style={{ width: 440, height: 956, borderRadius: 26, overflow: 'hidden', background: '#fff' }}>
          <div aria-label="iOS 狀態列示意" style={{ height: 56, position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 28px', boxSizing: 'border-box', fontSize: 13, fontWeight: 600 }}>
            <span>9:41</span><span aria-label="Dynamic Island" style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', width: 125, height: 34, borderRadius: 24, background: '#000' }} />
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }} aria-label="行動訊號與電量示意"><svg width="17" height="13" viewBox="0 0 17 13" aria-hidden="true"><path d="M1 9h2v4H1zm4-3h2v7H5zm4-3h2v10H9zm4-3h3v13h-3z" fill="currentColor" /></svg><svg width="25" height="13" viewBox="0 0 25 13" aria-hidden="true"><rect x="1" y="1" width="20" height="11" rx="3" fill="none" stroke="currentColor" /><rect x="3" y="3" width="16" height="7" rx="1" fill="currentColor" /><path d="M23 4v5" stroke="currentColor" strokeWidth="2" /></svg></span>
          </div>
          <iframe title="直播翻譯台手機網頁 viewport 440 × 812" src="/live?demo=1" width="440" height="812" style={{ width: 440, height: 812, border: 0, display: 'block', background: '#fff' }} />
          <div aria-label="Safari 瀏覽器外框示意，非操作按鈕" style={{ height: 88, boxSizing: 'border-box', background: '#f4f4f5', borderTop: '1px solid #dedee1', padding: '8px 18px 0' }}>
            <div style={{ height: 32, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#e4e4e8', borderRadius: 11, padding: '0 13px', fontSize: 12 }}><span>AA</span><span>localhost / live</span><span>↻</span></div>
            <div style={{ height: 29, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 14px', fontSize: 19, color: '#666' }} aria-hidden="true"><span>‹</span><span>›</span><span>↥</span><span>▣</span><span>□</span></div>
            <div aria-label="Home Indicator" style={{ width: 125, height: 5, background: '#222', borderRadius: 4, margin: '5px auto 0' }} />
          </div>
        </div>
      </div>
      <p style={{ fontSize: 12, textAlign: 'center', maxWidth: 440 }}>440 × 956 包含 iOS 狀態列與 Safari 外框，網頁區為 440 × 812。僅驗證手機尺寸版面；收音仍需桌面 Chrome 擴充功能，不代表手機可安裝或收音。</p>
    </div>
  </main>;
}
