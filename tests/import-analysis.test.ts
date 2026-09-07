import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkBody, findMoatTerms, ImportAnalysisError, inferRole, parseBlocks, parseExternalAnalysis, stripCitationMarkers } from '../lib/pipeline/import-analysis';
import { SOCIAL_CARD_COUNT } from '../lib/pipeline/extract-summary';

// 模擬 NotebookLM 複製出來的繁中回答：句尾有引用編號、粗體標籤、巢狀編號清單。
const SAMPLE = `Rourke Sefton-Minns 創立的 Gen HQ 在一年內從零規模化至八位數營收 1 。他的 AI 商業模式主要包含三大核心獲利管道：

1. **品牌合作與贊助 (Brand Partnerships)**：這是他最主要的收入來源，每月可帶來約 35 萬至 60 萬美元的收入 2 。由於 AI 公司極度需要觸及受眾，因此透過社群內容進行工具推廣與教學，能創造極高的商業價值 2 。
2. **社群訂閱與教育 (Subscription & Education)**：旗下的 Gen HQ 每月產生約 15 萬美元的營收 2 。此模式提供 AI 創意課程與實用模板（如合約、提案、發票等），解決「如何用 AI 賺錢、開發客戶和建立作品集」等核心痛點 3 4 。
3. **人才媒合平台 (Marketplace)**：他正準備推出全新的平台，直接協助 AI 創作者對接預算介於 500 到 1 萬美元之間的全職或接案工作 5 。

**如何從零開始？Rourke 的「極速起步指南」**

如果你想在工作之餘（如 9 到 5 的上班族）開啟 AI 副業，Rourke 提出了一套極具操作性的實戰藍圖 6 ：

- **思維轉變：先找客戶，再學技術** 許多人誤以為要先把所有 AI 工具學到極致才能接案，但 Rourke 認為應該先做最難的部分——尋找客戶、簽訂合約，拿到訂單後，再去研究如何用 AI 實現它 7 。在實作過程中，AI 本身就是極佳的排錯與思考夥伴，能幫你解決各種突發問題 8 。
- **「3 個月、24 支 Spec 作品」實戰計劃**
  1. **高頻率產出**：每週利用下班時間製作 2 支概念性商業廣告（Spec Work） 6 9 。
  2. **鎖定藍海利基**：避免去擠 Nike 或時尚等競爭極為激烈的領域，可以選擇吸塵器、果汁機或瓶裝水等「較少人涉足的日常消費品」來製作廣告，更容易吸引該品牌注意 10 11 。
  3. **標記工具與合作**：在影片角落加上所使用的 AI 工具浮水印，並嘗試在 3 個月後申請該工具的創意合作夥伴計畫（Creative Partner Program）以取得免費額度降低成本 9 。
- **LinkedIn 內容槓桿（Jab, Jab, Hook 模式）**
  1. **分享製作過程**：在 LinkedIn（目前最被低估的 AI 接案渠道）上分享你製作的廣告，並撰寫貼文記錄如何製作這支影片 6 12 。3 個月下來，你將擁有 24 支影片與 24 篇教學貼文（共 48 個內容資產），這會形成強大的作品集並展示你的成長軌跡 12 。
  2. **精準社群滲透**：在發布作品前，先在 LinkedIn 上與該品牌的員工或行銷決策者建立連結，讓影片有可能在他們的內部 Slack 等管道被主動分享 13 。
  3. **「三刺一勾」主動出擊**：套用 Gary Vee 的「Jab, Jab, Hook」原則，連續為該品牌做 3 次 Spec 作品（Jab），到第 4 次時再主動私訊 LinkedIn 上的決策者，表達對品牌的熱愛並附上你的作品，開啟商業對話 11 14 。

**系統化創作與避免倦怠**

在推動這套商業模式時，Rourke 也強調了營運細節：

- **影片分級管理**：為維持高頻率產出，他將內容分為 A 級（15 小時快速交件、全 AI 生成無人臉）、**B 級（2 天交件、需親自拍攝加中度特效）**與 C 級（1 週交件、需研發新工具並著重故事敘事） 15 。
- **「北極星指標」決策法**：設定一個超越金錢的宏大願景（例如他的目標是「為創意人創造 10 萬個工作機會」） 18 19 。這能幫你在面臨選擇時（例如是否要接下高薪但耗時的個人諮詢），快速做出符合商業長遠利益的決定 19 20 。
- **預防與應對倦怠**：AI 領域變化極快，容易讓人焦慮並產生嚴重倦怠 21 22 。Rourke 指出，當他把最愛的創作工作外包、自己變成純管理者時，反而經歷了嚴重倦怠 23 。因此，保留自己最熱愛的創作部分（如編寫劇本、設計趣味敘事）並從中獲得樂趣，才是商業模式能持續運行的關鍵 23 24 。

💡 想進一步深入了解他推薦的 LinkedIn 開發客戶腳本，還是他的影片分級創作流程？`;

test('citation markers are removed only where they are footnotes, never real numbers', () => {
  assert.equal(stripCitationMarkers('八位數營收 1 。'), '八位數營收。');
  assert.equal(stripCitationMarkers('核心痛點 3 4 。'), '核心痛點。');
  assert.equal(stripCitationMarkers('每週製作 2 支廣告'), '每週製作 2 支廣告');
  assert.equal(stripCitationMarkers('35 萬至 60 萬美元的收入 2 。'), '35 萬至 60 萬美元的收入。');
  assert.equal(stripCitationMarkers('（Ep. 78）'), '（Ep. 78）');
  assert.equal(stripCitationMarkers('預算介於 500 到 1 萬美元'), '預算介於 500 到 1 萬美元');
  assert.equal(stripCitationMarkers('引用[1]與 [2, 3] 都拿掉'), '引用與  都拿掉');
  assert.equal(stripCitationMarkers('上標¹²也拿掉'), '上標也拿掉');
  // 行尾裸數字有歧義（可能是分數），預設保留，寧可多留一個引用編號。
  assert.equal(stripCitationMarkers('句尾編號 12\n下一行'), '句尾編號 12\n下一行');
  assert.equal(stripCitationMarkers('本次得分 100'), '本次得分 100');
  assert.equal(stripCitationMarkers('面積 = (x+y)²'), '面積 = (x+y)²');
  // Codex 第一輪抓到的真數字反例：沒有被空白包夾、跟在冒號或頓號旁的數字都要留著。
  assert.equal(stripCitationMarkers('完成數： 20。'), '完成數： 20。');
  assert.equal(stripCitationMarkers('第 3、4 步'), '第 3、4 步');
  assert.equal(stripCitationMarkers('得分 100，排名 2。'), '得分 100，排名 2。');
  assert.equal(stripCitationMarkers('x² + y² = z²'), 'x² + y² = z²');
  assert.equal(stripCitationMarkers('（Spec Work） 6 9 。'), '（Spec Work）。');
  assert.equal(stripCitationMarkers('實戰藍圖 6 ：'), '實戰藍圖：');
});

test('pathological inputs stay linear and the raw length limit counts whitespace', () => {
  const started = Date.now();
  parseBlocks('['.repeat(59_000));
  stripCitationMarkers('中 1' + ' '.repeat(39_000) + 'x');
  parseBlocks(`# 標題${' '.repeat(59_000)}\n\n- 項目：內容。`);
  parseBlocks(`**粗體${' '.repeat(59_000)}**\n\n- 項目：內容。`);
  assert.ok(Date.now() - started < 400, `regex work took ${Date.now() - started}ms`);
  const long = parseBlocks(`# 標題${' '.repeat(59_000)}#\n\n**粗體標題**：\n\n- 項目：內容。`);
  assert.deepEqual(long.slice(0, 2), [{ kind: 'heading', level: 1, text: '標題' }, { kind: 'heading', level: 3, text: '粗體標題' }]);
  const padded = `${'# 標題\n\n開場段落先交代這部影片在講什麼，讓字數超過最少門檻。'}${' '.repeat(70_000)}`;
  assert.throws(() => parseExternalAnalysis(padded, {}), (error: unknown) => error instanceof ImportAnalysisError && error.status === 413);
  assert.throws(() => chunkBody('abc', 1), RangeError);
});

test('blocks recognise markdown headings, bold-only headings, bullets and skip short lead-ins', () => {
  const blocks = parseBlocks('# 大標\n\n開場段落 1 。\n\n**粗體章節**\n\n以下是重點：\n\n- **標籤**：內容一 2 。\n  1. 子項：內容二\n\n💡 想再問嗎？');
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'paragraph', 'heading', 'item', 'item', 'paragraph']);
  assert.equal((blocks[0] as { text: string }).text, '大標');
  assert.equal((blocks[1] as { text: string }).text, '開場段落。');
  assert.equal((blocks[2] as { text: string }).text, '粗體章節');
  assert.equal((blocks[3] as { text: string }).text, '標籤：內容一。');
  assert.equal((blocks[4] as { indent: number }).indent, 2);
  assert.equal((blocks[5] as { text: string }).text, '想再問嗎？');
});

test('bodies split at sentence boundaries under the 110 character card limit', () => {
  const sentence = '這是一句大約三十個字的中文句子，用來測試切段是否會停在句號。';
  const chunks = chunkBody(sentence.repeat(6));
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) { assert.ok(Array.from(chunk).length <= 110); assert.match(chunk, /。$/); }
  assert.deepEqual(chunkBody(''), []);
  const hard = chunkBody('無句讀'.repeat(60));
  assert.ok(hard.every(chunk => Array.from(chunk).length <= 110));
});

test('roles come from the title first so a burnout section renders as a warning card', () => {
  assert.equal(inferRole('預防與應對倦怠', 'AI 領域變化極快'), 'warning');
  assert.equal(inferRole('「三刺一勾」主動出擊', '套用原則'), 'action');
  assert.equal(inferRole('影片分級管理', '內容分為 A 級'), 'workflow');
  assert.equal(inferRole('品牌合作與贊助 (Brand Partnerships)', '每月可帶來約 35 萬美元的收入'), 'business');
  assert.equal(inferRole('一般觀察', '每週 2 支'), 'evidence');
  assert.equal(inferRole('「先找客戶」', '短金句'), 'quote');
  assert.equal(inferRole('這成立嗎？', '想一想'), 'reflection');
  assert.equal(inferRole('普通標題', '普通內文'), 'insight');
});

test('a NotebookLM answer becomes exactly 20 cards with hook first, closing last and no invented claims', () => {
  const result = parseExternalAnalysis(SAMPLE, { title: '他一年內打造 8 位數 AI 事業', provider: 'notebooklm' });
  assert.equal(result.cards.length, SOCIAL_CARD_COUNT);
  assert.equal(result.cards[0].role, 'hook');
  assert.equal(result.cards[0].title, '他一年內打造 8 位數 AI 事業');
  assert.match(result.cards[0].body, /^Rourke Sefton-Minns 創立的 Gen HQ/);
  assert.ok(!result.cards[0].body.includes(' 1 '));
  assert.equal(result.cards[1].role, 'context');
  assert.equal(result.cards[18].role, 'recap');
  assert.match(result.cards[18].body, /如何從零開始/);
  assert.equal(result.cards[19].role, 'closing');
  assert.deepEqual(result.sections, ['如何從零開始？Rourke 的「極速起步指南」', '系統化創作與避免倦怠']);
  const first = result.cards[2];
  assert.equal(first.title, '品牌合作與贊助 (Brand Partnerships)');
  assert.equal(first.role, 'business');
  assert.match(first.body, /35 萬至 60 萬美元的收入。/);
  const nested = result.cards.find(card => card.title === '高頻率產出');
  assert.ok(nested, 'nested numbered items become their own cards');
  assert.equal(nested!.eyebrow, '3 個月、24 支 S…');
  assert.equal(result.padded, 0);
  assert.ok(result.contentCards > 16 && result.dropped === result.contentCards - 16);
  assert.match(result.warnings[0], /沒有放進圖卡/);
  for (const card of result.cards) {
    assert.ok(Array.from(card.title).length <= 30 && Array.from(card.body).length <= 110 && Array.from(card.eyebrow).length <= 12);
    assert.ok(card.title && card.body);
  }
  // 提示問句與引用編號都不會變成一頁。
  assert.ok(!result.cards.some(card => card.body.includes('想進一步深入了解')));
});

test('short or thin analyses fail loudly instead of fabricating pages', () => {
  assert.throws(() => parseExternalAnalysis('太短', {}), ImportAnalysisError);
  const thin = ['# 標題', '', '開場段落先交代這部影片在講什麼，讓字數超過最少門檻。', '', '- 甲：第一點內容，寫長一點但不到一頁的上限。', '- 乙：第二點內容，寫長一點但不到一頁的上限。', '- 丙：第三點內容，寫長一點但不到一頁的上限。', '- 丁：第四點內容，寫長一點但不到一頁的上限。', '- 戊：第五點內容，寫長一點但不到一頁的上限。', '- 己：第六點內容，寫長一點但不到一頁的上限。'].join('\n');
  assert.throws(() => parseExternalAnalysis(thin, {}), (error: unknown) => error instanceof ImportAnalysisError && /只夠組成 16 頁/.test(error.message));
  const enough = `${thin}\n- 庚：第七點。\n- 辛：第八點。\n- 壬：第九點。\n- 癸：第十點。\n- 子：第十一點。\n- 丑：第十二點。`;
  const padded = parseExternalAnalysis(enough, {});
  assert.equal(padded.cards.length, 20);
  assert.equal(padded.padded, 4);
  assert.equal(padded.cards.filter(card => card.eyebrow === '再想一步').length, 4);
  assert.match(padded.warnings[0], /補了 4 頁反思提示/);
});

test('moat term check only reports exact hits and ignores comments', () => {
  assert.deepEqual(findMoatTerms('這篇提到南部魚貨 B2B', ['# 註解', '', '988 廚房', '南部魚貨']), ['南部魚貨']);
});
