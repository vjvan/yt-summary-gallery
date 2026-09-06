---
title: YT Summary 第一版近即時字幕
created: 2026-09-05
status: implemented-awaiting-live-translation-acceptance
---

# 近即時字幕：第一版

在原 YT Summary 旁增加獨立觀看支線，不替換既有影片庫、摘要、圖卡或上傳流程。

## 範圍

- 有英文原文字幕的已上架 YouTube 影片，人工英文優先，其次英文 ASR 原文。
- 不把 YouTube 自動翻譯的中文／英文字幕當原文；無字幕明確提示，不偷偷下載音訊或啟動付費轉錄。
- 官方 IFrame Player API 觀看頁 `/watch`；Chrome 擴充套件為 `extensions/yt-summary-watch`。
- 字幕先讀原文，語意合併後以固定 8 cue 分批，前後各帶 2 cue 語境。
- 先翻目前位置，最多預取下一批且距目前時間 30 秒內；不等全片、摘要或圖卡。
- 台灣繁中 + 既有可編輯術語表 + 內建小型 Weave／影像術語補充；使用者指定譯法優先，不覆寫資料庫。
- 以 cue ID 與 `start <= currentTime < end` 顯示，不把 SSE／網路請求時鐘當影片時鐘。

不包含：直播、無字幕收音、配音、逐格畫面理解、保證零延遲、雲端 SaaS 部署。擴充功能第一版只支援桌面 YouTube `/watch`，不保證 Shorts／會員／需登入或受限影片。

## 開啟方式

在原專案 `/Users/vjvan/yt-summary-gallery`：

```sh
npm ci --cache /private/tmp/yt-summary-npm-cache
npm run dev
```

開啟 `http://127.0.0.1:3000/watch`。`/watch?demo=1` 是純前端 5 句示例，**非模型翻譯成果**，不呼叫 Watch API 或 YouTube；手機預覽 `/watch/mobile-preview` 也是示例。

1. 貼 YouTube 連結，先載入播放器與原文字幕。
2. 明確同意原文、前後文、影片標題與相關術語送交模型後，啟用翻譯，再播放。
3. 翻好一批即顯示。可切繁中／原文／雙語，點逐字稿跳轉。
4. 停止後須重新載入影片建立新 session；快取仍保留。

後端沿用已有 `OPENAI_API_KEY`，不在網頁或擴充套件輸入／儲存 OpenAI key。沒有 key 時仍可看原文。此輪開發沒有讀取、複製或更改原專案 `.env.local`。

## Chrome 一次性設定

1. Chrome 開 `chrome://extensions`，開啟「開發人員模式」。
2. 「載入未封裝項目」，選擇 `/Users/vjvan/yt-summary-gallery/extensions/yt-summary-watch`。
3. 在本機 `/watch` 手動展開配對碼並複製，僅貼到這個擴充套件的 popup。
4. 伺服器填 `http://127.0.0.1:3000`，切到 YouTube 影片頁，先把本次上限設 **2 批**驗收。
5. 同意字幕送交模型與費用後才啟用；確認品質後再自行選擇自動模式。

配對碼屬本機憑證，請勿分享。它不是 OpenAI API key。擴充功能預設 off，未自動安裝到使用者 Chrome。詳細行為與權限見擴充套件 README。

## 架構與 API

`/api/watch/pair` 僅本機同源頁面可取得 token。其他 API 均需 Bearer token，Host 必須 loopback；CORS 只接受同源或 Chrome extension origin，不接受 YouTube 網站本身的要求。

| 方法／路由 | 作用 |
|---|---|
| GET `/api/watch/pair` | 本機配對碼與預設上限，no-store |
| POST `/api/watch/session` | `{url,sourceLanguage:"en"}` → 原文與 session，尚未付費翻譯 |
| POST `/api/watch/window` | `{sessionId,time,confirmTranslation:true}` → 該批譯文 |
| POST `/api/watch/session/{id}/stop` | 中止並關閉 session |
| GET `/api/watch/jobs/{id}` | 查詢非同步工作的 processing/done/錯誤 |
| DELETE `/api/watch/jobs/{id}` | 取消非同步工作 |

擴充套件在 session/window POST 加 `Prefer: respond-async`，立即得到 202 `{jobId,status:"processing"}`，再用短 GET 輪詢。避免 MV3 等待單次長 fetch；不靠永久 heartbeat 撐住背景程序。原網頁仍可用同步 POST，契約兼容。

這些工作執行於持續運作的本機 Node server，不是 serverless job queue；不要直接套到現有 cloud-api。伺服器重啟後重開 session，翻譯快取與每日用量仍在。

## 快取、取消與費用

- 獨立 SQLite：`data/watch.db`，不改原 `summaries` 表。儲存翻譯與每日批次數。
- 快取鍵含影片、來源 track/content hash、目標語言、完整術語快照與 prompt/model version。
- 術語修改後**重新載入影片**才建立新快照；已進行 session 不會半途混用新舊詞庫。
- 預設每 session **25 次**、每日 **100 次**模型請求；每日按 Asia/Taipei。可透過後端 `WATCH_SESSION_CALL_LIMIT`（最高100）、`WATCH_DAILY_CALL_LIMIT`（最高500）調低或調整。
- 批次不是金額保證。請求前先預留額度；失敗、取消仍可能已向供應商計費，照樣計入，不自動無限重試。
- 相同窗口在處理中會防重複，快取命中不增加模型次數。擴充端另有較保守的本次上限。
- 取消／跳轉會停止舊請求與忽略過時回覆，但**不能保證已送出請求不計費**。
- 暫時錯誤可重試；沒有完整合法 ID/JSON/繁中輸出不寫成功快取，也不把英文 fallback 標成翻譯完成。
- 配對碼檔案 `data/.watch-pairing-token` 0600、gitignored；不寫入日誌或字幕。

## 驗證記錄（2026-09-05）

- 實際取得使用者 `kfbWz9_bJoA` 影片的英文自動原文字幕（78 個語意 cue），未呼叫付費模型。
- 依真實資料修復原 ASR 時窗重疊：只以已觀察到的下一 cue 起點截斷，不捏造詞級時間。
- Mock 測試涵蓋 URL／來源選擇、翻譯 JSON、時間邊界、快取、術語覆寫、同意、額度、取消、配對、CORS、async jobs 和擴充訊息。
- Next production build、TypeScript、新增檔案 scoped ESLint 為交付 gate。
- Chrome 示範頁實看：點逐字稿跳轉、繁中切換正常；手機 nav 改水平捲動、不斷字。
- **尚未驗收**：真實模型翻譯的專業語意／延遲、使用者 Chrome 安裝後的完整有費端到端、YouTube 廣告／全螢幕／DOM 改版兼容性。

## 下一步驗收

以原 Weave 影片，從 3:43 附近先跑 2 批，檢查 masking／background layer／compositor node 的自然譯法與時間對齊。測暫停、倒帶、1.5 倍速、切片與停用；看 API 帳單與本機額度後，再增加預譯量。若譯文仍不自然，先修語意合併與術語，不盲目替換模型。

官方參考：
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- https://developers.google.com/youtube/iframe_api_reference
- https://developers.openai.com/api/docs/guides/structured-outputs
