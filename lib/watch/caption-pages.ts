/** Display-only subtitle paging. Nothing here translates, summarizes or changes
 * cue timing. Concatenating page.text always reconstructs the exact input. */
export interface CaptionPage { text: string; lines: string[]; weight: number }
export interface CaptionPageOptions { lineUnits?: number; pageUnits?: number; maxLines?: number }
export interface CaptionPageSelection {
  index: number; page: CaptionPage | null; total: number; timingKnown: boolean; dense: boolean;
}

const graphemes = (text: string): string[] => Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), part => part.segment);
export function captionTextWeight(text: string): number {
  return graphemes(text).reduce((total, character) => total + (/^[\r\n]$/.test(character) || character === '\r\n' ? 0
    : /^[ \t]$/.test(character) ? 0.3 : /^[\x21-\x7e]$/.test(character) ? 0.55 : 1), 0);
}
const bounded = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;

/** Keep English words/identifiers and title-case platform names together when
 * they fit. Only an overlong token is split at grapheme boundaries. */
function captionTokens(text: string, maximum: number): string[] {
  const raw = text.match(/\r\n|[\r\n]|[ \t]+|[A-Z][A-Za-z0-9]*(?:[ \t]+[A-Z][A-Za-z0-9]*)+|[A-Za-z0-9_]+(?:[.+/#:@%?=&-][A-Za-z0-9_]+)*|[^\r\n]/gu) || [];
  const joined: string[] = [];
  // Re-segment non-ASCII runs so an emoji/combining mark is never cut in half.
  for (let i = 0; i < raw.length; i++) {
    if (/^\p{Mark}/u.test(raw[i]) && joined.length) {
      // Regex may have separated an ASCII base from its decomposed accents.
      // Keep Cafe\u0301 / numeric keycaps as one token before any page split.
      joined[joined.length - 1] += raw[i];
    } else if (/[^\x00-\x7f]/.test(raw[i])) {
      let run = raw[i];
      while (i + 1 < raw.length && /[^\x00-\x7f]/.test(raw[i + 1])) run += raw[++i];
      joined.push(...Array.from(new Intl.Segmenter('zh-Hant', { granularity: 'word' }).segment(run), part => part.segment));
    } else joined.push(raw[i]);
  }
  return joined.flatMap(token => {
    if (captionTextWeight(token) <= maximum) return [token];
    const pieces: string[] = []; let part = '', weight = 0;
    for (const character of graphemes(token)) {
      const next = captionTextWeight(character);
      if (part && weight + next > maximum) { pieces.push(part); part = ''; weight = 0; }
      part += character; weight += next;
    }
    if (part) pieces.push(part);
    return pieces;
  });
}

export function splitCaptionPages(text: string, options: CaptionPageOptions = {}): CaptionPage[] {
  if (!text) return [];
  const lineUnits = bounded(options.lineUnits, 22, 4, 100);
  const pageUnits = bounded(options.pageUnits, 32, 4, 200);
  const maxLines = Math.floor(bounded(options.maxLines, 2, 1, 2));
  const tokens = captionTokens(text, Math.min(lineUnits, pageUnits));
  const weights = tokens.map(captionTextWeight);
  const prefix = [0];
  for (const weight of weights) prefix.push(prefix[prefix.length - 1] + weight);

  // First estimate the minimum page count using the real line/page limits.
  // The second pass balances that count instead of filling page one to the brim
  // and leaving a two-character orphan on the final page.
  const fittingEnds = (start: number): number[] => {
    const ends: number[] = [];
    let lineWeight = 0, lines = 1, pageWeight = 0, lineHasText = false;
    for (let end = start; end < tokens.length; end++) {
      const weight = weights[end];
      if (pageWeight + weight > pageUnits + 1e-8) break;
      if (lineHasText && lineWeight + weight > lineUnits + 1e-8) {
        lines++; lineWeight = 0; lineHasText = false;
      }
      if (lines > maxLines) break;
      lineWeight += weight; pageWeight += weight; lineHasText = true;
      ends.push(end + 1);
      if (/^[\r\n]+$/.test(tokens[end])) {
        lines++; lineWeight = 0; lineHasText = false;
      }
    }
    return ends;
  };
  const endsByStart = tokens.map((_, start) => fittingEnds(start));
  const minimumPages = new Array<number>(tokens.length + 1).fill(0);
  for (let start = tokens.length - 1; start >= 0; start--) {
    const ends = endsByStart[start];
    minimumPages[start] = 1 + minimumPages[ends[ends.length - 1]];
  }
  const pages: CaptionPage[] = [];
  let start = 0, remainingPages = minimumPages[0];
  while (start < tokens.length) {
    const target = (prefix[tokens.length] - prefix[start]) / remainingPages;
    let chosen = endsByStart[start][0], bestScore = Infinity;
    for (const end of endsByStart[start]) {
      if (minimumPages[end] > remainingPages - 1) continue;
      if (end < tokens.length && remainingPages === 1) continue;
      const weight = prefix[end] - prefix[start];
      const before = tokens.slice(start, end).join('').trimEnd();
      const after = tokens.slice(end).join('').trimStart();
      let score = Math.abs(weight - target);
      // Prefer a nearby sentence/clause end, but not a tiny punctuation-only
      // page or an almost-full page followed by an orphan. Spaces stay exact.
      if (weight >= target * 0.5 && weight <= target * 1.5 && /[，。！？、；：,.!?;:]$/.test(before)) score -= target * 0.4;
      if (/^[，。！？、；：）》」』】,.!?;:]/.test(after) || /[（《「『【(]$/.test(before)) score += pageUnits;
      if (/^[ \t]+$/.test(tokens[end - 1])) score -= 0.1;
      if (end < tokens.length && prefix[tokens.length] - prefix[end] < Math.min(4, target * 0.4)) score += pageUnits;
      if (score < bestScore) { bestScore = score; chosen = end; }
    }
    const lines: string[] = [];
    let line = '', lineWeight = 0;
    for (let i = start; i < chosen; i++) {
      if (line && lineWeight + weights[i] > lineUnits + 1e-8) { lines.push(line); line = ''; lineWeight = 0; }
      line += tokens[i]; lineWeight += weights[i];
      if (/^[\r\n]+$/.test(tokens[i])) { lines.push(line); line = ''; lineWeight = 0; }
    }
    if (line) lines.push(line);
    pages.push({ text: tokens.slice(start, chosen).join(''), lines, weight: prefix[chosen] - prefix[start] });
    start = chosen; remainingPages--;
  }
  return pages;
}

/** Approximate pages within the ORIGINAL cue interval by text weight. No wall
 * clock or playing flag: pause is stable, seek recomputes, mode changes do not
 * restart a page. Dense intervals are flagged, never slowed/sped up here. */
export function selectCaptionPage(pages: CaptionPage[], input: {
  start?: number; end?: number; time: number; minPageSeconds?: number;
}): CaptionPageSelection {
  const timingKnown = Number.isFinite(input.start) && Number.isFinite(input.end)
    && input.start! >= 0 && input.end! > input.start!;
  const total = pages.length;
  if (!total) return { index: 0, page: null, total: 0, timingKnown, dense: false };
  if (!timingKnown) return { index: 0, page: pages[0], total, timingKnown: false, dense: total > 1 };
  const duration = input.end! - input.start!;
  const progress = Number.isFinite(input.time) ? Math.min(1, Math.max(0, (input.time - input.start!) / duration)) : 0;
  const weights = pages.map(page => Math.max(0.01, page.weight));
  const sum = weights.reduce((a, b) => a + b, 0);
  const minSeconds = bounded(input.minPageSeconds, 1.2, 0.1, 10);
  const dense = total > 1 && weights.some(weight => duration * weight / sum < minSeconds);
  let boundary = 0, index = total - 1;
  for (let i = 0; i < total; i++) {
    boundary += weights[i] / sum;
    if (progress < boundary) { index = i; break; }
  }
  return { index, page: pages[index], total, timingKnown, dense };
}
