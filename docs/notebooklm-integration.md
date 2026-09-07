# NotebookLM 三層分工（2026-09-07）

影片字幕翻譯庫從這一版起採三層分工：**理解層交給 NotebookLM，字幕層與產出層留在本機**。本機 7B 的摘要與 20 頁學習卡萃取降為備援：沒有外部分析時仍會自動產出，有外部分析貼入時以貼入內容為準。

| 層 | 誰做 | 為什麼 |
|---|---|---|
| 理解層 | NotebookLM（輸出語言設繁體中文） | 重點萃取、問答、報告品質高，免費 |
| 字幕層 | `/watch` 與 Chrome 擴充、台灣用語字庫 | 觀看時雙語、台灣口語、本機不外送 |
| 產出層 | 20 頁三軸圖卡、Carousel 打包、AIVAN Studio | 市面沒有對標的產線 |

兩條路都不碰 NotebookLM 的 API（個人帳號沒有官方 API，非官方工具每週在壞），全部靠使用者手動貼與上傳。

## 一、NotebookLM 來源包（工具 → NotebookLM）

- 入口：影片詳情頁「字幕檔下載」區的 **NotebookLM 來源包** 按鈕；API 為 `GET /api/summaries/{id}/notebooklm-source?lang=bi|en|zh`（預設 `bi`）。
- 內容：純文字檔，檔頭有標題、來源網址、頻道、片長；之後每句兩行，各帶時間戳，先英文原句、後繁中譯文（台灣用語，已過字庫）。
- 用法：在 NotebookLM 把它加為第二個來源（第一個是 YouTube 網址本身）。之後提問時，NotebookLM 會引用帶時間戳的譯文與英文原句，回答自然帶影片位置與台灣用語。
- 邊界：中譯未完成或與原文段數對不齊時，`bi` 只輸出英文並在檔頭註明；`zh` 直接回 409。只讀資料庫，不呼叫模型、不改資料。
- 上限：NotebookLM 單一來源 50 萬字，兩小時影片約一千六百句不會超過。

## 二、外部分析貼入（NotebookLM → 工具）

- 入口：影片詳情頁按鈕 **貼入 NotebookLM 分析**；API 為 `POST /api/summaries/{id}/import-analysis`，body `{ text, provider?, dryRun? }`；`DELETE` 同路徑還原匯入前的版本。
- 解析：`lib/pipeline/import-analysis.ts` 用確定性規則切頁，**不呼叫任何模型**。標題（`#`、粗體獨立行、短句冒號）當章節，編號與項目清單每項一頁，`標籤：內容` 拆成標題與內文，超過 110 字的段落依句讀切成多頁。NotebookLM 複製時帶出的引用編號（句尾小數字、`[1]`、上標）會被拿掉，但緊接單位的真數字（`2 支`、`35 萬`）保留。
- 頁數：固定 20 頁。第 1 頁 hook 用一級標題或影片標題加開場段落，第 2 頁 context，第 19 頁 recap 列章節，第 20 頁 closing 固定句；中間 16 頁全部來自貼入文字。內容超過 16 段時後面的段落不放，會在預覽提醒；不足時最多補 6 頁「再想一步」反思提示（模板句，不含新主張），再不足就拒絕匯入，不補造。
- 角色：從標題判斷（倦怠／風險→warning、步驟／方法→action、流程／分級→workflow、整句被引號包住→quote），其餘看內文（營收／客戶→business、數字加單位→evidence），預設 insight。
- 寫入：只改 `summary.social_cards` 與 `summary.social_cards_source`（`external:notebooklm`），其餘摘要欄位、字幕、私人筆記不動。`summaries.external_analysis` 存原文、時間、SHA-256 與**第一次匯入前**的 20 頁，多次匯入仍能還原到本機或雲端萃取的原稿。
- 重畫：匯入成功後前端以目前三軸樣式呼叫既有 `regenerate-cards`。重畫進行中（`card_render_token` 佔用）匯入與還原都回 409。
- 護城河：`data/moat-terms.txt`（不進 git，一行一詞）存在時，命中的詞會在預覽用警告列出，不阻擋；圖卡會對外發佈，貼入前自己判斷。

## 三、備援關係

- 本機 7B 摘要仍在 `lib/pipeline/local-summary.ts`，新影片沒有貼入分析時照常跑，圖卡先有東西。
- 貼入後再跑字幕續作或重畫，不會覆蓋貼入的 20 頁（`runLocalYoutubeLibrary` 只在沒有 summary 時才萃取）。
- 想回到本機版本：貼入面板底部「還原成匯入前的內容並重畫」。

## 四、驗證

```sh
node --import tsx --test tests/notebooklm-source.test.ts tests/import-analysis.test.ts tests/import-analysis-routes.test.ts
```

Chrome smoke：影片詳情頁下載來源包確認每句兩行帶時間戳；貼入一段 NotebookLM 回答看到 20 頁預覽與警告；匯入後圖卡第 1、19、20 頁對應 hook、recap、closing；還原後回到原本內容。
