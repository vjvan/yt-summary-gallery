# YT Summary Cloud API

## 目前範圍

Cloud API 只保存 AIVAN Slide Studio 需要的 Project JSON 與 append-only 草稿版本。

- 影片下載、Whisper、翻譯、`ffmpeg` 與 `yt-dlp`：仍由本機 YT Summary worker 執行。
- Project JSON 讀取與版本儲存：Vercel Cloud API。
- 持久資料：Vercel Private Blob（香港區域）。
- 存取方式：每個 Summary 各自擁有不可猜測的 capability token；雲端只保存 token hash。
- 版本保護：`record.json` 使用 ETag 條件寫入，另保存 immutable revision JSON。

這個切法避免把長時間影片處理硬塞進 Serverless，也先解決 Slide Studio 無法連到 `127.0.0.1` 的問題。

## 雲端環境變數

`cloud-api/`：

- `BLOB_READ_WRITE_TOKEN`（連接 Vercel Private Blob 後自動建立）
- `YT_SUMMARY_INGEST_TOKEN`
- `AIVAN_SLIDE_STUDIO_ORIGINS`

本機 YT Summary：

- `AIVAN_CLOUD_API_URL`
- `AIVAN_CLOUD_INGEST_TOKEN`
- `AIVAN_CLOUD_SIGNING_SECRET`
- `NEXT_PUBLIC_AIVAN_SLIDE_STUDIO_URL`

所有 secret 只能放 `.env.local`、Vercel Environment Variables 或 Keychain，不得提交 Git。

## 正式部署

- Vercel project：`aivan-yt-summary-api`
- Production URL：<https://aivan-yt-summary-api.vercel.app>
- Blob store：`aivan-yt-summary-projects`，Private，`hkg1`

```bash
cd cloud-api
vercel link --yes --project aivan-yt-summary-api
npm run build
vercel deploy --prod --yes
```

部署後先檢查：

```bash
curl https://aivan-yt-summary-api.vercel.app/api/health
```

主要 endpoints：

- `GET /api/health`：服務與儲存健康狀態。
- `POST /api/summaries/:id/aivan-project/source`：本機 worker 發佈／更新來源 Project JSON。
- `GET /api/summaries/:id/aivan-project?access=...`：Studio 讀取專案。
- `PUT /api/summaries/:id/aivan-project`：Studio 以 Bearer token 儲存下一個 revision。

## 同步

先啟動本機 YT Summary，再執行：

```bash
npm run cloud:sync
```

每次從影片詳情頁點「在 AIVAN Studio 編輯」時，也會先同步該 Project JSON，再把 Cloud API URL 傳給 Studio。

本機 YT Summary 的 `dev`／`start` 只綁定 `127.0.0.1`。雲端發佈 route 會使用 server-side ingest token，不應暴露在區域網路或公開網路。

## 官方依據

- Vercel Functions 寫入檔案應改用外部持久化儲存：<https://vercel.com/kb/guide/how-can-i-use-files-in-serverless-functions>
- Private Blob 所有讀寫都需要驗證：<https://vercel.com/docs/vercel-blob/private-storage>
- ETag conditional writes 可避免平行編輯互相覆蓋：<https://vercel.com/docs/vercel-blob#conditional-writes>
