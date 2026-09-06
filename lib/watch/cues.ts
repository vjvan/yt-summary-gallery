import { createHash } from 'node:crypto';
import { WatchError } from './errors';
import type { WatchCue } from './types';

export interface CaptionSegment { start: number; end: number; text: string }
const MAX_MERGE_SECONDS = 8;
const MAX_CUE_CHARS = 400;
const BATCH_SIZE = 8;

function cleanText(text: string): string {
  return text.replace(/<[^<>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    }[entity] || entity))
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value: string) => {
      const point = value.startsWith('x') ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

/** JSON3 window events may repeat the preceding words. Deduplicate only temporal overlaps. */
export function normalizeCaptionSegments(input: CaptionSegment[]): WatchCue[] {
  const ordered = input.map((cue) => ({ ...cue, text: cleanText(cue.text) }))
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end)
      && cue.start >= 0 && cue.end > cue.start && cue.text.length > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const deduplicated: CaptionSegment[] = [];
  let previousDisplay: CaptionSegment | undefined;
  for (const original of ordered) {
    const cue = { ...original };
    const previous = deduplicated[deduplicated.length - 1];
    const precedingDisplay = previousDisplay;
    previousDisplay = original;
    if (previous && precedingDisplay && cue.start < precedingDisplay.end - 0.01) {
      if (precedingDisplay.text === cue.text) {
        previous.end = Math.max(previous.end, cue.end);
        continue;
      }
      const priorWords = precedingDisplay.text.split(' ');
      const words = cue.text.split(' ');
      let overlap = 0;
      for (let count = Math.min(priorWords.length, words.length); count > 0; count--) {
        if (priorWords.slice(-count).join(' ') === words.slice(0, count).join(' ')) {
          overlap = count;
          break;
        }
      }
      if (overlap > 0) {
        if (overlap === words.length) {
          // A shorter rolling duplicate is not another spoken sentence.
          previous.end = Math.max(previous.end, cue.end);
          continue;
        }
        cue.text = words.slice(overlap).join(' ');
        if (cue.start > previous.start) previous.end = Math.min(previous.end, cue.start);
      }
    }
    deduplicated.push(cue);
  }
  const merged: CaptionSegment[] = [];
  for (const cue of deduplicated) {
    const previous = merged[merged.length - 1];
    const joined = previous ? `${previous.text} ${cue.text}` : '';
    if (previous && !/[.!?。！？]["'”’)]?$/.test(previous.text)
      && cue.start - previous.end <= 0.65 && cue.start >= previous.start
      && cue.end - previous.start <= MAX_MERGE_SECONDS && joined.length <= MAX_CUE_CHARS) {
      previous.text = joined;
      previous.end = Math.max(previous.end, cue.end);
    } else {
      // Preserve a source cue's real timing even if it is longer than the merge budget.
      // In particular, never manufacture word timestamps by evenly dividing a sentence.
      merged.push({ ...cue });
    }
  }
  // YouTube display durations often overlap the next observed spoken segment.
  // Share exact-start text in one display unit, then stop at the next real start.
  // No evenly spaced or model-generated timestamps are introduced.
  const timeline: CaptionSegment[] = [];
  for (const cue of merged) {
    const previous = timeline[timeline.length - 1];
    if (previous && previous.start === cue.start) {
      if (previous.text !== cue.text) previous.text = `${previous.text} ${cue.text}`;
      previous.end = Math.max(previous.end, cue.end);
    } else {
      if (previous && previous.end > cue.start) previous.end = cue.start;
      timeline.push({ ...cue });
    }
  }
  return timeline.map((cue) => ({
    ...cue,
    id: `cue_${createHash('sha256').update(`${cue.start}|${cue.end}|${cue.text}`).digest('hex').slice(0, 20)}`,
  }));
}

export function parseJson3Captions(raw: string): WatchCue[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new WatchError('INVALID_CAPTIONS', '字幕 JSON3 格式無效。'); }
  if (!data || typeof data !== 'object' || !Array.isArray((data as { events?: unknown }).events)) {
    throw new WatchError('INVALID_CAPTIONS', '字幕 JSON3 格式無效。');
  }
  const events = (data as { events: unknown[] }).events;
  if (events.length > 50_000) throw new WatchError('CAPTION_LIMIT', '字幕事件數量超過第一版上限。');
  const segments: CaptionSegment[] = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const e = event as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown };
    if (typeof e.tStartMs !== 'number' || typeof e.dDurationMs !== 'number' || !Array.isArray(e.segs)) continue;
    const text = e.segs.map((segment: unknown) => {
      if (!segment || typeof segment !== 'object') return '';
      const utf8 = (segment as { utf8?: unknown }).utf8;
      return typeof utf8 === 'string' ? utf8 : '';
    }).join('');
    segments.push({ start: e.tStartMs / 1000, end: (e.tStartMs + e.dDurationMs) / 1000, text });
  }
  return normalizeCaptionSegments(segments);
}

function parseTime(value: string): number {
  const match = value.match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseVttCaptions(raw: string): WatchCue[] {
  const segments: CaptionSegment[] = [];
  for (const block of raw.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].trim().match(/^(\S+)\s+-->\s+(\S+)/);
    if (!match) continue;
    segments.push({ start: parseTime(match[1]), end: parseTime(match[2]), text: lines.slice(timeIndex + 1).join(' ') });
    if (segments.length > 50_000) throw new WatchError('CAPTION_LIMIT', '字幕片段數量超過第一版上限。');
  }
  return normalizeCaptionSegments(segments);
}

/** Fixed batches make seek-prioritisation deterministic and permit cache reuse. */
export function selectWindow(cues: WatchCue[], time: number): {
  targets: WatchCue[]; before: WatchCue[]; after: WatchCue[]; windowKey: string;
} {
  if (!cues.length) return { targets: [], before: [], after: [], windowKey: 'empty' };
  const position = Number.isFinite(time) ? Math.max(0, time) : 0;
  const index = cues.findIndex((cue) => cue.end > position);
  if (index < 0) return { targets: [], before: [], after: [], windowKey: 'end' };
  const batchIndex = Math.floor(index / BATCH_SIZE);
  const first = batchIndex * BATCH_SIZE;
  const targets = cues.slice(first, first + BATCH_SIZE);
  return {
    targets,
    before: cues.slice(Math.max(0, first - 2), first),
    after: cues.slice(first + targets.length, first + targets.length + 2),
    windowKey: String(batchIndex),
  };
}
