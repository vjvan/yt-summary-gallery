/**
 * 語意風險旗標：純規則，不呼叫模型。用來決定哪些句子優先重譯、哪些候選要人工多看一眼。
 * 旗標是「值得檢查」不是「一定錯」；只有 negation / magnitude / question 有拿現行譯文對照。
 */
import type { ReviewCue, RiskCode, RiskFlag } from './types';

const NEGATION = /\b(?:not|never|nobody|nothing|none|neither|nor|without|cannot|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't|hasn't|haven't|hadn't|ain't)\b|n't\b/i;
const ZH_NEGATION = /[不沒無非未別莫勿否免]/;
const MAGNITUDE = /\b(?:thousand|thousands|million|millions|billion|billions|trillion|trillions|grand)\b|\b\d[\d,.]*\s?[kKmMbB]\b/;
const COMPARISON = /\b(?:more|less|fewer|than|better|worse|bigger|smaller|higher|lower|faster|slower|cheaper|instead of|rather than|versus|vs\.?)\b/i;
const FOREGROUND = /\b(?:white|black|red|blue|green|dark|light|text|logo)\s+on\s+(?:a\s+|the\s+)?(?:white|black|red|blue|green|dark|light|background)\b|\b(?:on top of|underneath|behind|in front of|foreground|background)\b/i;
const IDIOM = /\b(?:jab|hook|outbound|inbound|white[- ]label|on the fly|out of the box|game[- ]changer|no[- ]brainer|low[- ]hanging fruit|under the hood|rule of thumb|spec work|cold (?:email|outreach|dm)|leverage|posture|take your job)\b/i;
const PRONOUN_LEAD = /^(?:it|this|that|they|them|these|those|which|he|she|his|her|their)\b/i;

// 前五種是「對照現行譯文後發現的落差」，主導優先序；後四種只是提醒需要前後文，
// 自動字幕幾乎每句都是片段，若讓 fragment 帶分會把整片都標成高風險。
export const RISK_WEIGHTS: Record<RiskCode, number> = {
  negation: 5, magnitude: 5, foreground: 4, question: 3, quantity: 3, idiom: 2, fragment: 1, comparison: 1, pronoun: 1,
};

function digits(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*%?/g) ?? []).map(value => value.replace(/,/g, ''));
}

function isStatementTurnedQuestion(source: string, current: string): boolean {
  const sourceAsks = /\?\s*$/.test(source.trim());
  // 中文問句不一定有問號：句尾「嗎」與「敢不敢／是不是／有沒有」這種正反問也算。
  const trimmed = current.trim();
  const currentAsks = /[？?]\s*$/.test(trimmed) || /嗎[？?。]?\s*$/.test(trimmed) || /(\S)[不沒]\1/.test(trimmed);
  return sourceAsks !== currentAsks;
}

/** 量級對照：million 應是百萬、billion 應是十億，出現「億／兆」而沒有對應字眼就標記。 */
function magnitudeMismatch(source: string, current: string): string | null {
  const lower = source.toLowerCase();
  const hasMillion = /\bmillions?\b|\d\s?m\b/i.test(lower);
  const hasBillion = /\bbillions?\b|\d\s?b\b/i.test(lower);
  const hasThousand = /\bthousands?\b|\d\s?k\b/i.test(lower);
  const hasTrillion = /\btrillions?\b/.test(lower);
  if (hasTrillion && !/兆/.test(current)) return 'trillion 應為「兆」';
  if (hasBillion && !/十億|億|10 ?億/.test(current)) return 'billion 應為「十億」量級';
  if (hasBillion && /兆/.test(current)) return 'billion 被寫成「兆」';
  if (hasMillion && !/百萬|萬|million/i.test(current)) return 'million 應為「百萬」量級';
  if (hasMillion && /[^百]億|^億/.test(current) && !/百萬/.test(current)) return 'million 被放大成「億」';
  if (hasThousand && !/千|萬|thousand/i.test(current)) return 'thousand 應為「千」量級';
  // 80 grand / 80k 是八萬，不是八十萬；兩位數以下的 grand/k 出現十萬以上量級就標記。
  // 從完整數值起頭匹配（含小數與千分位），不能從 8.5 的 5 開始算。
  const grand = /(?<![\d.,])(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s?(?:grand|k)\b/i.exec(lower);
  if (grand && /十萬|百萬|千萬|億/.test(current)) {
    const amount = Math.round(Number(grand[1].replace(/,/g, '')) * 1000);
    if (Number.isFinite(amount) && amount < 100_000) return `${grand[0]} 是 ${amount}（${Number((amount / 10_000).toFixed(4))} 萬），譯文量級過大`;
  }
  return null;
}

export function detectRiskFlags(cue: Pick<ReviewCue, 'source' | 'current'>, previous?: Pick<ReviewCue, 'source'> | null): RiskFlag[] {
  const source = cue.source.trim();
  const current = (cue.current ?? '').trim();
  const flags: RiskFlag[] = [];
  const push = (code: RiskCode, detail: string) => { if (!flags.some(flag => flag.code === code)) flags.push({ code, detail }); };

  const negationMatch = source.match(NEGATION);
  if (negationMatch) {
    if (current && !ZH_NEGATION.test(current)) push('negation', `原文有「${negationMatch[0]}」，譯文沒有否定詞`);
    else if (!current) push('negation', `原文有否定「${negationMatch[0]}」`);
  }
  if (MAGNITUDE.test(source)) {
    const mismatch = current ? magnitudeMismatch(source, current) : null;
    if (mismatch) push('magnitude', mismatch);
    else if (!current) push('magnitude', '原文含千／百萬／十億等量級詞');
  }
  const sourceDigits = digits(source);
  if (sourceDigits.length) {
    const currentDigits = new Set(digits(current));
    const missing = sourceDigits.filter(value => !currentDigits.has(value));
    if (current && missing.length) push('quantity', `數字未逐字保留：${missing.join('、')}`);
  }
  if (current && isStatementTurnedQuestion(source, current)) push('question', /\?\s*$/.test(source) ? '原文是問句，譯文不是' : '原文是敘述，譯文變成問句');
  const foreground = source.match(FOREGROUND);
  if (foreground) push('foreground', `前後景／位置關係：「${foreground[0]}」`);
  if (/^[a-z]/.test(source) || (previous && !/[.?!…]["')\]]?\s*$/.test(previous.source.trim()))) push('fragment', '接續上一句的片段，需要前後文');
  const comparison = source.match(COMPARISON);
  if (comparison) push('comparison', `比較或取捨：「${comparison[0]}」`);
  const idiom = source.match(IDIOM);
  if (idiom) push('idiom', `慣用語或行話：「${idiom[0]}」`);
  if (PRONOUN_LEAD.test(source) && source.split(/\s+/).length <= 8) push('pronoun', '代名詞開頭的短句，指涉在前文');
  return flags;
}

export function riskScore(flags: RiskFlag[]): number {
  return flags.reduce((sum, flag) => sum + RISK_WEIGHTS[flag.code], 0);
}
