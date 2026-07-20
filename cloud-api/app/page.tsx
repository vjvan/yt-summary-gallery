export default function Home() {
  return (
    <main>
      <div className="eyebrow">AIVAN Creator Infrastructure</div>
      <h1>YT Summary<br />Cloud API</h1>
      <p>
        這個服務負責保存 YT Summary 產生的 Project JSON，並提供 AIVAN Slide Studio
        跨裝置讀取、版本衝突保護與雙向草稿儲存。
      </p>
      <p>服務狀態：<a href="/api/health"><code>/api/health</code></a></p>
    </main>
  );
}
