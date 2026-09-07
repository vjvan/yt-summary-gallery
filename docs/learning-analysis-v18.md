# 私人學習分析 v18

- 只在使用者明確同意後，手動分析一部影片。GET 不啟動模型，失敗／取消後保留上次分析及檢查點。
- 原片、模型判讀、授權目標下的個人建議分開。私人資料存 learning_* 表，不寫入 summaries JSON、原字幕或既有 20 張卡。
- 目前模型路徑固定使用本機 Ollama adapter，沒有自動雲端 fallback；本功能不改模型設定。

## 2026-09-07 真實 smoke 修正

第一版要求 Qwen 2.5 7B 同時複製英文 quote 與產生繁中文案，但真實第 1 段回傳的 3 個 quote 全被翻成中文，因此精確證據檢查全部拒絕；不能把生成完的 JSON 等同有效進度。檢查沒有放寬。

版本 `learning-v1.1-source-anchors` 改為模型只選 chunk 內唯一 `anchorId`（原行 id + offset）。長來源行先拆成最多 480 字片段，保留原始行 id 和小數時間。伺服器依選定錨點複製 exact quote 和 timestamp，再核對原始來源。不是事後猜時間、模糊對齊，亦不是無條件截取長行前 500 字。

連續 3 段格式／引用全部異常會停止後續推論，留下安全診斷 code。單一壞候選不妨礙同段其餘有效候選；部分結果存 partial checkpoint，手動重試仍會重新提取該段。完整成功的 chunk 使用正常 checkpoint。

來源提取設保守防線：`8 figures` 未明言 revenue/profit 時不能自動改成營收／利潤；明顯漏否定及不在證據中的數字須重新覆核。這些是有限規則，不是通用事實查核；模型的 sourceFaithfulness 覆核與人工語意驗收仍然必要。遇過度保守排除，應回查來源，而不是調低 exact-evidence 門檻。

OpenCC + 既有台灣用語正規化僅套用模型 core、explanation、whyImportant、conditions、application、assessment.reason、sourceFaithfulness.reason 和 reason。來源 quote、id、timestamp、hash、英文品牌與使用者實作筆記不做此轉換。**字形／用語轉換不等於修正語意、證明可信或改善來源品質。**

公共內容仍是白名單來源觀點草稿，少於 20 頁標示不足，不補造；即使引用字串核對成功，也不稱為完成的繁中 Carousel 或獨立查證的事實。
