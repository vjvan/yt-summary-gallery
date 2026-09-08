/**
 * 把一個話語視窗切成「英文句子」錨點。
 *
 * YouTube 自動字幕的 cue 是任意切段：實測一支 1123 句的影片有 926 句不在句尾斷、584 句中間含句號。
 * v1 把整窗翻成一段中文再按字數比例切回各 cue，只要模型多翻或少翻一點，句界就往後滑一整句。
 * v2 改成：模型逐「句」翻，切回各 cue 只在句內按字數比例分配，漂移被關在一句之內。
 *
 * 句子與 cue 是多對多：一句可跨多個 cue（span），一個 cue 也可含多句的片段。
 * 這裡只切原文與算權重，不碰時間軸與 cue id。
 */
import type { ReviewCue, ReviewWindow } from './types';

export interface SentenceSpan {
  /** cue 在視窗內的位置（window.cues 的 index），不是全片 index。 */
  position: number;
  /** 該句落在這個 cue 的字元數，切回時當比例。 */
  weight: number;
}

export interface WindowSentence {
  /** 從 1 起算，送給模型也用這個號碼對回來。 */
  n: number;
  /** 送給模型的原文（不含講者標籤與 >> 換人標記）。 */
  text: string;
  spans: SentenceSpan[];
  /** 原文以句尾標點結束；最後一句若沒結束，才需要 after 當上下文。 */
  terminated: boolean;
  /** 這句以 >> 換人標記開頭，譯文切回時要把標記接回去。 */
  marker: string;
  /** 每個字與它所在的 cue 位置，讓數字提醒能掛回正確的 cue。 */
  tokens: { text: string; position: number }[];
}

const SPEAKER_LABEL = /^([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3} \(\d{1,2}:\d{2}(?::\d{2})?\))\s*/;
const TERMINAL = /[.?!…]+["'’”)\]]*$/;
// 縮寫與單一大寫字母後的句號不是句尾（Mr. / U.S. / J. Crew）。
const ABBREVIATION = /^(?:[A-Z]\.|(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|approx|Inc|Ltd|Co|No|U\.S|U\.K|a\.m|p\.m|e\.g|i\.e)\.)$/i;
const SPEAKER_TURN = /^>{2,}$/;

/** 講者標籤不進模型（它會把標籤複製到每句），切回時再接到原本那句前面。 */
export function splitSpeakerLabel(source: string): { label: string; text: string } {
  const match = SPEAKER_LABEL.exec(source.trim());
  return match ? { label: match[1], text: source.trim().slice(match[0].length) } : { label: '', text: source.trim() };
}

const isSentenceEnd = (token: string) => TERMINAL.test(token) && !ABBREVIATION.test(token);

export function splitWindowSentences(window: Pick<ReviewWindow, 'cues'>): WindowSentence[] {
  const sentences: WindowSentence[] = [];
  let tokens: { text: string; position: number }[] = [];
  let spans: SentenceSpan[] = [];
  let marker = '';
  const close = (terminated: boolean) => {
    if (tokens.length) sentences.push({ n: sentences.length + 1, text: tokens.map(token => token.text).join(' '), spans, terminated, marker, tokens });
    tokens = [];
    spans = [];
    marker = '';
  };
  const addWeight = (position: number, weight: number) => {
    const last = spans[spans.length - 1];
    if (last && last.position === position) last.weight += weight;
    else spans.push({ position, weight });
  };
  window.cues.forEach((cue: ReviewCue, position: number) => {
    const words = splitSpeakerLabel(cue.source).text.split(/\s+/).filter(Boolean);
    for (const word of words) {
      if (SPEAKER_TURN.test(word)) {
        close(false);
        marker = '>> ';
        continue;
      }
      tokens.push({ text: word, position });
      addWeight(position, Array.from(word).length);
      if (isSentenceEnd(word)) close(true);
    }
  });
  close(false);
  return sentences;
}
