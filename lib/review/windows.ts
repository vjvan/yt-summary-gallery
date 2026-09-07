/**
 * 把逐句字幕切成「完整話語視窗」：句尾標點、停頓、講者標籤或上限到了就收窗。
 * 每個視窗帶前後各兩句當上下文；模型只翻視窗內的句子，id 與時間軸完全沿用原字幕。
 */
import { detectRiskFlags, riskScore } from './risk-flags';
import type { ReviewCue, ReviewWindow, RiskFlag } from './types';

export interface WindowOptions {
  maxCues?: number;
  maxSeconds?: number;
  maxChars?: number;
  gapSeconds?: number;
  contextCues?: number;
}

const DEFAULTS: Required<WindowOptions> = { maxCues: 6, maxSeconds: 40, maxChars: 600, gapSeconds: 1.5, contextCues: 2 };
const SENTENCE_END = /[.?!…]["')\]]?\s*$/;
const SPEAKER_LABEL = /^[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,3} \(\d{1,2}:\d{2}(?::\d{2})?\)/;

export function toReviewCues(segments: Array<{ start: number; end: number; text: string }>, segmentsZh: Array<{ start: number; end: number; text: string }> | null, ids?: string[]): ReviewCue[] {
  const aligned = segmentsZh && segmentsZh.length === segments.length ? segmentsZh : null;
  return segments.map((segment, index) => ({
    index,
    id: ids?.[index] ?? `cue-${index}`,
    start: segment.start,
    end: segment.end,
    source: segment.text,
    current: aligned ? aligned[index].text : null,
  }));
}

export function buildReviewWindows(cues: ReviewCue[], options: WindowOptions = {}): ReviewWindow[] {
  const config = { ...DEFAULTS, ...options };
  const windows: ReviewWindow[] = [];
  let group: ReviewCue[] = [];
  let chars = 0;
  const close = () => {
    if (!group.length) return;
    const first = group[0].index;
    const last = group[group.length - 1].index;
    const flags: RiskFlag[] = [];
    let score = 0;
    let top = 0;
    for (const cue of group) {
      const cueFlags = detectRiskFlags(cue, cue.index > 0 ? cues[cue.index - 1] : null);
      const cueScore = riskScore(cueFlags);
      top = Math.max(top, cueScore);
      score += cueScore;
      for (const flag of cueFlags) if (!flags.some(existing => existing.code === flag.code)) flags.push(flag);
    }
    windows.push({
      key: `w-${first}-${last}`,
      cues: group,
      before: cues.slice(Math.max(0, first - config.contextCues), first),
      after: cues.slice(last + 1, last + 1 + config.contextCues),
      flags,
      // 最高的那句主導，其餘句只加一半，避免長視窗光靠句數堆高分。
      score: Math.round((top + (score - top) / 2) * 10) / 10,
    });
    group = [];
    chars = 0;
  };
  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index];
    const text = cue.source.trim();
    if (!text) { close(); continue; }
    const next = cues[index + 1];
    if (group.length && SPEAKER_LABEL.test(text)) close();
    if (group.length && (group.length >= config.maxCues || chars + text.length > config.maxChars || cue.end - group[0].start > config.maxSeconds)) close();
    group.push(cue);
    chars += text.length;
    const sentenceEnd = SENTENCE_END.test(text);
    const longGap = next ? next.start - cue.end > config.gapSeconds : true;
    if (sentenceEnd || longGap) close();
  }
  close();
  return windows;
}

/** 依風險分數排序，同分依時間順序；`minScore` 以下的視窗不在優先名單。 */
export function prioritizeWindows(windows: ReviewWindow[], minScore = 3): ReviewWindow[] {
  return windows.filter(window => window.score >= minScore).sort((a, b) => b.score - a.score || a.cues[0].index - b.cues[0].index);
}
