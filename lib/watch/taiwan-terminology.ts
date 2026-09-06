import type { Glossary } from '../glossary-defaults';

// Curated Taiwan vocabulary applied after character conversion, so keys are the
// Traditional forms a Mainland-trained model still emits. OpenCC's phrase table
// was rejected: on 1279 public cues it also rewrote ordinary words (連接→連線).
// Single characters (挺, 搞), shared words (數據, 優化, 支持, 實現) and words whose
// Taiwan meaning differs by context (文件, 菜單, 終端, 循環, 對象, 項目 = item, 推理, bare 智能)
// are deliberately absent; those belong to prompt style rules, not to a blind rewrite.
const SAFE_TERMS: Readonly<Record<string, string>> = {
  // media
  '視頻通話': '視訊通話', '視頻會議': '視訊會議', '視頻': '影片', '音頻': '音訊', '圖像生成': '影像生成', '截屏': '截圖', '分辨率': '解析度', '攝像頭': '攝影機',
  // software / hardware
  '軟件': '軟體', '硬件': '硬體', '服務器': '伺服器', '服務端': '伺服端', '數據庫': '資料庫', '內存': '記憶體', '硬盤': '硬碟', 'U盤': '隨身碟',
  '鼠標': '滑鼠', '屏幕': '螢幕', '光標': '游標', '打印': '列印', '剪貼板': '剪貼簿', '文件夾': '資料夾',
  // product / UX words
  '用戶': '使用者', '默認': '預設', '缺省': '預設', '界面': '介面', '交互': '互動', '反饋': '回饋', '激活': '啟用', '登錄': '登入', '在線': '線上',
  '信息': '訊息', '短信': '簡訊', '郵箱': '信箱', '鏈接': '連結', '文檔': '文件', '質量': '品質', '性能': '效能', '兼容': '相容',
  // engineering
  '網絡': '網路', '算法': '演算法', '雲計算': '雲端運算', '源代碼': '原始碼', '代碼': '程式碼', '調用': '呼叫', '字段': '欄位', '數組': '陣列', '隊列': '佇列',
  '線程': '執行緒', '變量': '變數', '函數': '函式', '布爾': '布林', '字符串': '字串', '字符': '字元', '命令行': '命令列', '存儲': '儲存',
  // AI (narrow phrases only: bare 智能 would also hit 智能障礙, and 推理 is right for 推理小說)
  '人工智能': '人工智慧', '智能手機': '智慧型手機', '智能體': '智慧體', '智能助理': '智慧助理',
  // speech
  '伙計': '老兄', '夥計': '老兄', '哥們': '兄弟', '播客': 'Podcast',
};
const SAFE_TERM_PATTERN = new RegExp(Object.keys(SAFE_TERMS).sort((a, b) => b.length - a.length).join('|'), 'g');
/** Transform only unquoted, unprotected spans; exact product names are never rewritten. */
function unprotected(text: string, protectedTerms: string[], transform: (value: string) => string): string {
  const mask = new Uint8Array(text.length);
  const protect = (from: number, to: number) => mask.fill(1, from, to);
  const quotes = /"(?:\\.|[^"\\])*"|'[^'\n]*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/g;
  for (const match of text.matchAll(quotes)) protect(match.index!, match.index! + match[0].length);
  for (const term of protectedTerms.filter(Boolean)) {
    let at = 0;
    while ((at = text.indexOf(term, at)) >= 0) { protect(at, at + term.length); at += term.length; }
  }
  let output = '', from = 0;
  while (from < text.length) {
    const protectedSpan = mask[from]; let to = from + 1;
    while (to < text.length && mask[to] === protectedSpan) to++;
    const span = text.slice(from, to); output += protectedSpan ? span : transform(span); from = to;
  }
  return output;
}
/** User term preferences win except the explicit request to replace ordinary 視頻 with 影片. */
export function normalizeTaiwanSubtitle(text: string, glossary: Glossary, toTraditional: (value: string) => string = value => value): string {
  const names = glossary.no_translate_terms.filter(term => term.length <= 120).slice(0, 500);
  const traditional = unprotected(text, names, toTraditional);
  const preferred = glossary.term_map.map(([, target]) => target).filter(target => target && target.length <= 120 && !/[視视]頻|视频/.test(target));
  return unprotected(traditional, [...names, ...preferred], span => span.replace(SAFE_TERM_PATTERN, term => SAFE_TERMS[term]));
}
