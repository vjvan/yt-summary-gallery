# Codex → Claude Code／Codex 接手紀錄

更新：2026-09-07。此檔是可提交的工程交接；不包含資料庫、API key、私人實作筆記、影音或真實字幕評測資料。

## 先讀這一段

- 專案：`yt-summary-gallery`，Next.js 16.2.1。先讀 `AGENTS.md` 與專案內附 Next.js 文件；不要套用舊版慣例。
- 遠端：`https://github.com/vjvan/yt-summary-gallery.git`，公開 repo；本次 checkpoint 以 `master` 為基準。
- 不假設任何另一個 agent 的 session 記憶存在。先跑 `git status --short`、`git log -3 --oneline`，核對現有服務與 port，再決定工作範圍。
- 同時使用 Claude Code／Codex 時，一次只由一方修改同一組檔案或部署；另一方可做唯讀 review。不要互相覆蓋未提交的變更，不要 `git reset --hard` 或 force push。
- 所有介面／說明採繁體中文與台灣用語。品牌與平台名如 OpenArt、Higgsfield 保留英文；「字幕全部有中文」不等於翻譯語義正確。

## 本次已完成的工程範圍

1. **字幕與影片庫恢復**：本機整片字幕處理、缺句／短句恢復、工作狀態、原片下載錯誤提示；動態提供字幕／卡片／影音產物。
2. **附加合法原片**：`attach-video` 可沿用同筆字幕，不重辨識或重翻；需要使用者授權與同版影片確認。檔案與片長檢查不能代替人工核對同步。
3. **Carousel 三軸樣式**：配色／字型組／背景；`card_style` 持久化，重畫、快速編輯與 AIVAN project 共用設定。字型與本機 render 依賴需另備，乾淨 clone 不附字型或生成圖片。
4. **證據學習 v18**：原片觀點／分析／私人用途分層，來源引用與時間戳、五個判斷問題、四種分類、驗證動作與私人實作紀錄；公開草稿用白名單隔離私人欄位。

重要檔案：

- `lib/learning/`、`components/LearningAnalysisPanel.tsx`、`app/api/summaries/[id]/learning/route.ts`
- `lib/card-style.ts`、`lib/pipeline/render-card.ts`、`components/CardStylePanel.tsx`
- `lib/pipeline/local-youtube-library.ts`、`lib/pipeline/attach-original.ts`、`lib/generated-media.ts`
- `docs/learning-analysis-v18.md`、`docs/watch-local.md`

學習分析使用 `learning-v1.1-source-anchors`：模型選 anchor，伺服器複製原文與時間戳；不是讓模型自行編引文。引用精確匹配仍不能保證推論正確。

## 內容與翻譯的真實驗收邊界

- 本機模型曾完整處理一支影片，但原始 7 點草稿仍有歸因與語義問題；示範另由助理對照原文重選、校訂成 4 點。**不是人類認證、外部事實查核或效益證明**。
- 這份示範存於本機 DB，不隨 Git 上傳；乾淨 clone 不會自帶影片或這 4 點內容。公開草稿不是已產出的新 20 張 PNG，不能為湊頁數捏造分析。
- 字幕校正只做了隔離評測：雲端對部分否定、數字、前後景有改善，但跨句詞義／慣用語仍錯；尚未把雲端校訂自動套用正式字幕，也未整庫重翻。
- 待深化方向：完整語意視窗重譯 → 回對時間軸 → 台灣術語與品牌規則 → 獨立高風險檢查 → 原文／初譯／校訂／核准版本分存。需要來源疑詞回聽及未見過的保留案例，不用模型自評分數當正確率。
- 本機評測工具、真實字幕 fixture、原始結果與私人覆核只保留原機；已用 `.gitignore` 明確排除。不要把這些檔案、環境檔或 DB 加進公開 repo。

## 本機服務與開機問題

- 正式入口為 `http://127.0.0.1:3000/`；舊 `3111` 僅是導向，不是第二份服務。
- 開機後曾因服務未啟動發生 `ERR_CONNECTION_REFUSED`。已用既有 `scripts/start-watch-local.mjs` 恢復；目前模式為 `local`／`qwen2.5:7b`。恢復時原有 11 筆摘要資料未變更。
- **登入自動啟動尚未實作，也尚未取得本輪該設定的明確確認**。不能說已解決重開機自啟；使用者目前要求先 commit／push／交接。
- 先檢查 `3000`、`3111`、`11434` 是否已有服務，不得另起重複程序或 kill 不明程序。既有服務沒有設定自啟時，關機後會停止。
- 沒有服務時，可依 `docs/watch-local.md` 操作；既有 build 與模型均備妥才可執行 `WATCH_LOCAL_MODEL=qwen2.5:7b npm run watch:local -- --port 3000`。不要每次登入都 build、下載模型或自動生成。

### 自啟實作前必須處理的安全項目

`instrumentation.ts` 會執行 `recoverZombieJobs()`。舊摘要管線可能自動續跑中斷任務，包括呼叫雲端模型；`WATCH_PROCESSING_MODE=local` 不能概括阻止所有舊管線。

因此在承諾「登入只開服務、不自動生成／花費」之前，需先加入明確的 legacy auto-resume 開關與測試（例如預設關閉、只有 `YT_SUMMARY_AUTO_RESUME=1` 才允許）。**這個開關目前不存在，不要只設定環境變數就宣稱有效。**

關閉時仍需安全回收中斷狀態與保存產物；不能整個略過 recovery。現有重新提交入口未必保留斷點，不能宣稱已有獨立手動 resume API。自啟方案需取得同意、以使用者 LaunchAgent 管理 loopback 服務、驗證退出重啟及下一次真正登入；bootstrap 成功不等於已測過重開機。

## 驗證與修改規則

使用者要求每次交付都實際 smoke test。不能只通過編譯就說可用。

```sh
# 在專案根目錄；這些測試不需真的呼叫模型。
node --import tsx --test tests/*.test.ts tests/*.test.cjs
node --test extensions/yt-summary-watch/tests/*.test.cjs
node_modules/.bin/tsc --noEmit
```

- `npm run build` 請在隔離工作目錄執行，不覆寫正在服務的 `.next`；本機字型、模型、ffmpeg 等可用性須另外檢查。
- 修改需驗 Chrome 桌面／手機、來源時間戳跳轉、資料保存與私人／公開隔離。只讀頁面不得啟動付費 API 或模型。
- 前次包含本機私人校正實驗的完整測試為 412 項、extension 100 項；公開 checkpoint 排除了私人 calibration 組，項數應以當次命令輸出為準，不沿用舊數字。
- 本次公開 checkpoint 的暫存內容已另存至隔離目錄驗證：程式測試 400／400、extension 100／100、TypeScript 及正式 build 通過。驗證目錄未帶入 `.env.local`、正式 DB 或私人校正 fixture。
- 已做過正式 Chrome 開機恢復 smoke：圖卡、證據學習、字幕資產與手機預覽可讀。這只驗網站恢復，不代表字幕語義全部校對完成。
- 更新／重啟前檢查 active jobs、備份 SQLite（含 WAL 的一致性備份），保存現有字幕、摘要、圖卡和私人筆記；不把隔離測試 DB 整份覆蓋正式 DB。
- API key 不要貼聊天或寫 repo。付費模型測試限使用者同意的範圍，保存實際 usage，不能默默 fallback 或整庫重翻。

## 接手後建議順序（不是自動執行授權）

1. 先確認使用者這次要深化「語意校訂」、「證據學習」或「登入自啟」，不要一次改全部。
2. 以同一支影片做小範圍校訂預覽，保留來源與版本，再擴大規則。
3. 若使用者同意自啟，先解 legacy 自動續跑／付費風險，再裝 LaunchAgent。
4. 本機校正實驗需在原機另讀；Git 上的純程式 checkout 不含個人內容。
