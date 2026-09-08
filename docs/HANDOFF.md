# Codex → Claude Code／Codex 接手紀錄

更新：2026-09-08（Claude Code 接手 d101c81 之後的一輪）。此檔是可提交的工程交接；不包含資料庫、API key、私人實作筆記、影音或真實字幕評測資料。

## 先讀這一段

- 專案：`yt-summary-gallery`，Next.js 16.2.1。先讀 `AGENTS.md` 與專案內附 Next.js 文件；不要套用舊版慣例。
- 遠端：`https://github.com/vjvan/yt-summary-gallery.git`；本次以 `master` 為基準。
- 不假設任何另一個 agent 的 session 記憶存在。先跑 `git status --short`、`git log -3 --oneline`，核對現有服務與 port，再決定工作範圍。
- 同時使用 Claude Code／Codex 時，一次只由一方修改同一組檔案或部署；另一方可做唯讀 review。不要互相覆蓋未提交的變更，不要 `git reset --hard` 或 force push。
- 所有介面／說明採繁體中文與台灣用語。品牌與平台名保留英文；「字幕全部有中文」不等於翻譯語義正確。

## 2026-09-07 到 09-08 這一輪做了什麼（Claude Code）

決策背景：影片字幕翻譯庫改「三層分工」，理解層交給 NotebookLM，自家守字幕層（觀看雙語、台灣用語字庫）與產出層（20 頁三軸圖卡），本機 7B 摘要萃取降為備援。研究與決策在 vault（`projects/yt-translation-tool/notebooklm-integration-research-2026-09-07.md`、`decisions/log.md` 2026-09-07）。

1. **NotebookLM 來源包**：`GET /api/summaries/{id}/notebooklm-source?lang=bi|en|zh`，逐句英文加繁中譯文各帶時間戳的純文字檔，上傳 NotebookLM 當第二個來源。卡片頁字幕下載區多一顆按鈕。純函式 `lib/pipeline/notebooklm-source.ts`。說明 `docs/notebooklm-integration.md`。
2. **外部分析貼入**：`POST/DELETE /api/summaries/{id}/import-analysis`。確定性解析器 `lib/pipeline/import-analysis.ts` 把 NotebookLM 繁中報告切成剛好 20 頁 SocialCard，只覆寫 `summary.social_cards` 與 `social_cards_source`（原始 JSON 物件不經正規化重寫），匯入前的兩個欄位原始值與存在旗標備份在新欄位 `summaries.external_analysis`，前端接既有 regenerate-cards 重畫；DELETE 逐字還原。面板 `components/AnalysisImportPanel.tsx`。
3. **影片庫渲染鎖**：`lib/pipeline/local-youtube-library.ts` 的 `renderLibraryCards` 改為原子取 `card_render_token`（與 regenerate-cards 共用同一欄位互斥），取鎖後才讀最新摘要，發布與失敗清理只認自己的鎖；重啟由 `recoverLocalLibraryJobs` 清鎖。這是 Codex 抓到的跨 worker 圖片覆蓋競態的修法。
5. **登入自啟與續跑開關（09-08）**：`scripts/launchd-3000.sh` 管理 launchd 代理程式 `com.vjvan.yt-summary-gallery`；`lib/pipeline/resume.ts` 新增 `YT_SUMMARY_AUTO_RESUME` 開關，預設不續跑舊管線。
6. **語意校訂 v2 句子錨點（09-08 早）**：允雷回報 8:41 到 9:10 視窗的候選整窗往後滑一句。根因：這支影片 1123 句字幕有 926 句不在句尾斷，v1 整段翻回再按字數比例切，模型多翻（把 after 翻進來）或少翻一點就整窗滑。改法：`lib/review/sentences.ts` 先把視窗切成英文句子（句尾標點、`>>` 換人標記、縮寫不算句尾），模型依 n 逐句回傳（schema 鎖句數），每句譯文只在該句跨到的 cue 之間按比例分配，漂移被關在一句之內；句數不符重試一次再退回 v1 比例切分並在備註標明。數字守門改成量級等價（10K 對 1 萬、50,000 對五萬、21 對二十一），且同一句兩個數字不能共用一個譯文數字。面板每窗多「重新校訂本窗」。`scripts/review-probe.ts` 可對指定視窗跑一次重譯印出候選（不寫 DB），用它比較過四個本機模型，結果寫在 `docs/watch-local.md` 的 `SUBTITLE_REVIEW_MODEL`。舊的 v1 候選在面板會標「舊版」且不算已完成，按「校訂高風險視窗」或該窗的「重新校訂本窗」就用 v2 重譯（重新校訂本窗會略過檢查點快取，真的再叫一次模型）。Codex 兩輪對抗審查（第一輪 1 P1 加 6 P2，第二輪 0 P1 加 7 P2）全部修掉並有回歸測試，紀錄在 vault `projects/yt-translation-tool/codex-reviews/2026-09-08-review-v2-sentence-anchor.md`。
4. **字幕語意校訂 v1**：`lib/review/*`、`app/api/summaries/{id}/subtitle-review`、`components/SubtitleReviewPanel.tsx`、卡片頁「語意校訂」分頁。話語視窗重譯（本機 Ollama，只送原文與前後文，模型回一段中文，伺服器依原文字數比例切回各句）、純規則風險旗標決定順序、候選逐句採用、套用才寫回 `segments_zh`／`transcript_zh` 與 SRT，並記 `subtitle_revisions` 可整批還原。說明與邊界 `docs/subtitle-review.md`。

## 驗證狀態

- 程式測試 464（09-08 上午 v2 加兩輪 Codex 修正後）、extension 100 全過；`tsc --noEmit` 乾淨；改動檔 eslint 乾淨（`lib/pipeline/assemble-video.ts`、`detect-source.ts` 各有一條既有 lint 問題，未動）。
- 隔離目錄 production build 通過（把 node_modules 用 APFS clone 進隔離目錄，symlink 會被 Turbopack 拒絕）。
- Chrome 實測（3001 開發伺服器，同一份正式 DB）：來源包 API 回 1123 句雙語；貼入面板 20 頁預覽、匯入後重畫第 1、3、19、20 頁目視正確、還原後回到本機萃取；語意校訂 3 個視窗 30 秒出 18 句候選、採用一句、套用後 DB／逐字稿／SRT 都更新、還原後與匯入前備份逐位元一致。
- Codex 對抗審查五輪：第一輪 4 P1 → 第五輪 0 P1（剩 5 P2 已修），全程見 vault `projects/yt-translation-tool/codex-reviews/2026-09-07-notebooklm-integration.md`。全部修法都有回歸測試。

## 內容與翻譯的真實驗收邊界

- 語意校訂的候選是 7B 模型輸出：實測會把整段語意翻對（否定句修好）但仍可能混入前後文、數字寫成中文或漏掉；備註會標出數字漏失與長度異常，採用前一定要自己看原文。沒有做「未見過的保留測試集」，不能宣稱整片正確率。
- 風險旗標會漏也會誤報，只決定順序不決定對錯。
- Chrome 擴充在 YouTube 原站用的是逐句快取（`data/watch*.db`），語意校訂套用只改影片庫的 `segments_zh` 與 SRT，不回寫擴充快取；已燒錄的 MP4 不會自動重燒。
- 本機評測工具、真實字幕 fixture 仍只保留原機；`.gitignore` 已排除。

## 本機服務與開機問題

- 正式入口為 `http://127.0.0.1:3000/`；舊 `3111` 僅是導向。
- **正式 3000 的語意校訂模型是 `qwen3.8:27b`（2026-09-08 允雷定案）**：由 launchd plist 的 `SUBTITLE_REVIEW_MODEL` 帶入，重裝自啟要用 `SUBTITLE_REVIEW_MODEL=qwen3.8:27b scripts/launchd-3000.sh install`，否則退回 7B。逐句首輪翻譯仍是 `qwen2.5:7b`。每窗約 35 到 40 秒，40 窗一輪約 25 分鐘。
- **登入自啟已完成（2026-09-08）**：launchd 使用者代理程式 `com.vjvan.yt-summary-gallery`，管理指令 `scripts/launchd-3000.sh {status|restart|stop|install|uninstall}`，細節與驗證證據見 `docs/watch-local.md` 的「登入自啟」。bootstrap、`kill -9` 自動重啟、`kickstart -k` 都實測過；**真正的重開機登入尚未實測**，下次登入先跑 `status`。
- 前置的安全項目已做：`recoverZombieJobs()` 預設不續跑舊摘要管線（`YT_SUMMARY_AUTO_RESUME=1` 才續跑），中斷任務標成可重試 error、產物保留；測試 `tests/resume-gate.test.ts` 用會爆炸的模型替身證明關閉時零模型呼叫。
- 部署：備份 DB → 確認沒有 processing／burning／持鎖列 → `npm run build` → `scripts/launchd-3000.sh restart`。不要再用 nohup 手動起，launchd 會跟它搶埠。
- 先檢查 `3000`、`3111`、`11434` 是否已有服務，不得另起重複程序或 kill 不明程序。

## 驗證與修改規則

```sh
node --import tsx --test tests/*.test.ts tests/*.test.cjs
node --test extensions/yt-summary-watch/tests/*.test.cjs
node_modules/.bin/tsc --noEmit
```

- `npm run build` 在隔離工作目錄執行；本機字型、模型、ffmpeg 可用性另外檢查。
- 修改需驗 Chrome 桌面／手機、來源時間戳跳轉、資料保存與私人／公開隔離。只讀頁面不得啟動付費 API 或模型。
- 更新／重啟前檢查 active jobs、備份 SQLite（含 WAL 的一致性備份）。
- API key 不要貼聊天或寫 repo。付費模型測試限使用者同意的範圍。

## 接手後建議順序（不是自動執行授權）

1. 語意校訂品質：用 `docs/translation-calibration-v18.md`（原機）的 12 個難例跑 `scripts/review-probe.ts`，逐例人工評；句子錨點已做（v2），剩下的是模型本身的取捨（見 `SUBTITLE_REVIEW_MODEL`）。若允雷決定換校訂模型，重跑 `SUBTITLE_REVIEW_MODEL=… scripts/launchd-3000.sh install`。
2. 登入自啟：下次真正重開機後跑 `scripts/launchd-3000.sh status` 確認 3000 有起來，並看 `data/launchd-3000.err.log`。
3. NotebookLM 貼入：多蒐集幾種 NotebookLM 輸出樣式（Study Guide、報告、FAQ）跑 dry-run，看切頁規則哪裡要補。
