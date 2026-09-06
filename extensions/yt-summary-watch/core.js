/* Shared pure helpers. No page scripts, tokens, or network access here. */
(function (scope) {
  'use strict';
  const BATCH_SIZE = 8;
  function serverOrigin(value) {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('伺服器限本機 http://127.0.0.1:連接埠 或 http://localhost:連接埠，不可包含路徑。');
    }
    return url.origin;
  }
  function youtubeUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
          url.username || url.password || url.pathname !== '/watch') return null;
      const id = url.searchParams.get('v');
      return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? { id, url: `https://www.youtube.com/watch?v=${id}` } : null;
    } catch { return null; }
  }
  function validCue(cue) {
    return cue && typeof cue.id === 'string' && Number.isFinite(cue.start) &&
      Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && typeof cue.text === 'string';
  }
  function currentCues(cues, time) {
    return cues.filter(cue => validCue(cue) && cue.start <= time && time < cue.end);
  }
  function batchAt(cues, time) {
    const index = cues.findIndex(cue => cue.end > time);
    if (index < 0) return null;
    const indexStart = Math.floor(index / BATCH_SIZE) * BATCH_SIZE;
    return { key: String(indexStart / BATCH_SIZE), indexStart, cues: cues.slice(indexStart, indexStart + BATCH_SIZE) };
  }
  function nextRequest(cues, time, ready) {
    const batch = batchAt(cues, time);
    if (!batch) return null;
    if (!ready.has(batch.key)) return { key: batch.key, time };
    const nextCue = cues[batch.indexStart + BATCH_SIZE];
    if (!nextCue || nextCue.start > time + 30) return null;
    const key = String(Number(batch.key) + 1);
    // Use a source boundary, not wall-clock buckets. This avoids skipping short batches.
    return ready.has(key) ? null : { key, time: batch.cues[batch.cues.length - 1].end + 0.01 };
  }
  function fullRequest(cues, time, ready, failed, retryKey = null) {
    const total = Math.ceil(cues.length / BATCH_SIZE);
    const valid = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < total;
    let key = valid(retryKey) && !ready.has(retryKey) ? retryKey : null;
    const current = batchAt(cues, time);
    if (key === null && current && !ready.has(current.key) && !failed.has(current.key)) key = current.key;
    if (key === null) for (let index = 0; index < total; index++) {
      if (!ready.has(String(index)) && !failed.has(String(index))) { key = String(index); break; }
    }
    // Backend-normalized source cues are chronological and non-overlapping.
    return key === null ? null : { key, time: cues[Number(key) * BATCH_SIZE].start };
  }
  function prefetchProgress(cues, translated, failed) {
    let readyCues = 0, failedCues = 0, readyBatches = 0;
    const failedBatches = new Set();
    for (let first = 0; first < cues.length; first += BATCH_SIZE) {
      const batch = cues.slice(first, first + BATCH_SIZE);
      let complete = true;
      for (const cue of batch) {
        if (translated.has(cue.id)) readyCues++;
        else { complete = false; if (failed.has(cue.id)) { failedCues++; failedBatches.add(String(first / BATCH_SIZE)); } }
      }
      if (complete) readyBatches++;
    }
    return { readyCues, totalCues: cues.length, failedCues, readyBatches, totalBatches: Math.ceil(cues.length / BATCH_SIZE), failedBatches: failedBatches.size,
      complete: cues.length > 0 && readyCues === cues.length, settled: cues.length > 0 && readyCues + failedCues === cues.length };
  }
  function bilingualSrt(cues, translated) {
    if (!cues.length || cues.some(cue => !validCue(cue) || !translated.has(cue.id))) return null;
    const stamp = seconds => {
      const ms = Math.round(seconds * 1000);
      return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
    };
    return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${translated.get(cue.id).text}\n${cue.text}`).join('\n\n') + '\n';
  }
  function isLocalProcessing(server) { return server?.processingMode === 'local'; }
  function isUnlimitedLocal(server) { return isLocalProcessing(server) && server.unlimited === true; }
  function translationLimit(server, clientLimit) {
    const declared = server?.limits?.sessionCalls ?? server?.sessionLimit;
    if (isUnlimitedLocal(server)) return null;
    if (isLocalProcessing(server)) return declared === null || declared === undefined ? null : Math.max(1, Number(declared));
    const cap = Math.min(50, Math.max(1, Math.floor(Number(clientLimit) || 10)));
    return Number.isFinite(declared) && declared > 0 ? Math.min(cap, declared) : cap;
  }
  function limitReached(server, used, clientLimit) {
    const limit = translationLimit(server, clientLimit);
    return limit !== null && used >= limit;
  }
  function boundedSettings(raw = {}) {
    return {
      server: serverOrigin(raw.server || 'http://127.0.0.1:3000'),
      token: typeof raw.token === 'string' ? raw.token.trim() : '',
      enabled: raw.enabled === true,
      consent: raw.consent === true,
      consentMode: raw.consentMode === 'local' ? 'local' : 'cloud',
      autoMode: raw.autoMode === true,
      localFullPrefetch: raw.localFullPrefetch !== false,
      maxBatches: Math.min(50, Math.max(1, Math.floor(Number(raw.maxBatches) || 10))),
      mode: ['bilingual', 'original', 'translated'].includes(raw.mode) ? raw.mode : 'bilingual',
    };
  }

  // Parity port of lib/watch/caption-pages.ts; display only, never rewrite source cues.
  const graphemes = (text) => Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), part => part.segment);
  function captionTextWeight(text) {
      return graphemes(text).reduce((total, character) => total + (/^[\r\n]$/.test(character) || character === '\r\n' ? 0
          : /^[ \t]$/.test(character) ? 0.3 : /^[\x21-\x7e]$/.test(character) ? 0.55 : 1), 0);
  }
  const bounded = (value, fallback, minimum, maximum) => typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
  /** Keep English words/identifiers and title-case platform names together when
   * they fit. Only an overlong token is split at grapheme boundaries. */
  function captionTokens(text, maximum) {
      const raw = text.match(/\r\n|[\r\n]|[ \t]+|[A-Z][A-Za-z0-9]*(?:[ \t]+[A-Z][A-Za-z0-9]*)+|[A-Za-z0-9_]+(?:[.+/#:@%?=&-][A-Za-z0-9_]+)*|[^\r\n]/gu) || [];
      const joined = [];
      // Re-segment non-ASCII runs so an emoji/combining mark is never cut in half.
      for (let i = 0; i < raw.length; i++) {
          if (/^\p{Mark}/u.test(raw[i]) && joined.length) {
              // Regex may have separated an ASCII base from its decomposed accents.
              // Keep Cafe\u0301 / numeric keycaps as one token before any page split.
              joined[joined.length - 1] += raw[i];
          }
          else if (/[^\x00-\x7f]/.test(raw[i])) {
              let run = raw[i];
              while (i + 1 < raw.length && /[^\x00-\x7f]/.test(raw[i + 1]))
                  run += raw[++i];
              joined.push(...Array.from(new Intl.Segmenter('zh-Hant', { granularity: 'word' }).segment(run), part => part.segment));
          }
          else
              joined.push(raw[i]);
      }
      return joined.flatMap(token => {
          if (captionTextWeight(token) <= maximum)
              return [token];
          const pieces = [];
          let part = '', weight = 0;
          for (const character of graphemes(token)) {
              const next = captionTextWeight(character);
              if (part && weight + next > maximum) {
                  pieces.push(part);
                  part = '';
                  weight = 0;
              }
              part += character;
              weight += next;
          }
          if (part)
              pieces.push(part);
          return pieces;
      });
  }
  function splitCaptionPages(text, options = {}) {
      if (!text)
          return [];
      const lineUnits = bounded(options.lineUnits, 22, 4, 100);
      const pageUnits = bounded(options.pageUnits, 32, 4, 200);
      const maxLines = Math.floor(bounded(options.maxLines, 2, 1, 2));
      const tokens = captionTokens(text, Math.min(lineUnits, pageUnits));
      const weights = tokens.map(captionTextWeight);
      const prefix = [0];
      for (const weight of weights)
          prefix.push(prefix[prefix.length - 1] + weight);
      // First estimate the minimum page count using the real line/page limits.
      // The second pass balances that count instead of filling page one to the brim
      // and leaving a two-character orphan on the final page.
      const fittingEnds = (start) => {
          const ends = [];
          let lineWeight = 0, lines = 1, pageWeight = 0, lineHasText = false;
          for (let end = start; end < tokens.length; end++) {
              const weight = weights[end];
              if (pageWeight + weight > pageUnits + 1e-8)
                  break;
              if (lineHasText && lineWeight + weight > lineUnits + 1e-8) {
                  lines++;
                  lineWeight = 0;
                  lineHasText = false;
              }
              if (lines > maxLines)
                  break;
              lineWeight += weight;
              pageWeight += weight;
              lineHasText = true;
              ends.push(end + 1);
              if (/^[\r\n]+$/.test(tokens[end])) {
                  lines++;
                  lineWeight = 0;
                  lineHasText = false;
              }
          }
          return ends;
      };
      const endsByStart = tokens.map((_, start) => fittingEnds(start));
      const minimumPages = new Array(tokens.length + 1).fill(0);
      for (let start = tokens.length - 1; start >= 0; start--) {
          const ends = endsByStart[start];
          minimumPages[start] = 1 + minimumPages[ends[ends.length - 1]];
      }
      const pages = [];
      let start = 0, remainingPages = minimumPages[0];
      while (start < tokens.length) {
          const target = (prefix[tokens.length] - prefix[start]) / remainingPages;
          let chosen = endsByStart[start][0], bestScore = Infinity;
          for (const end of endsByStart[start]) {
              if (minimumPages[end] > remainingPages - 1)
                  continue;
              if (end < tokens.length && remainingPages === 1)
                  continue;
              const weight = prefix[end] - prefix[start];
              const before = tokens.slice(start, end).join('').trimEnd();
              const after = tokens.slice(end).join('').trimStart();
              let score = Math.abs(weight - target);
              // Prefer a nearby sentence/clause end, but not a tiny punctuation-only
              // page or an almost-full page followed by an orphan. Spaces stay exact.
              if (weight >= target * 0.5 && weight <= target * 1.5 && /[，。！？、；：,.!?;:]$/.test(before))
                  score -= target * 0.4;
              if (/^[，。！？、；：）》」』】,.!?;:]/.test(after) || /[（《「『【(]$/.test(before))
                  score += pageUnits;
              if (/^[ \t]+$/.test(tokens[end - 1]))
                  score -= 0.1;
              if (end < tokens.length && prefix[tokens.length] - prefix[end] < Math.min(4, target * 0.4))
                  score += pageUnits;
              if (score < bestScore) {
                  bestScore = score;
                  chosen = end;
              }
          }
          const lines = [];
          let line = '', lineWeight = 0;
          for (let i = start; i < chosen; i++) {
              if (line && lineWeight + weights[i] > lineUnits + 1e-8) {
                  lines.push(line);
                  line = '';
                  lineWeight = 0;
              }
              line += tokens[i];
              lineWeight += weights[i];
              if (/^[\r\n]+$/.test(tokens[i])) {
                  lines.push(line);
                  line = '';
                  lineWeight = 0;
              }
          }
          if (line)
              lines.push(line);
          pages.push({ text: tokens.slice(start, chosen).join(''), lines, weight: prefix[chosen] - prefix[start] });
          start = chosen;
          remainingPages--;
      }
      return pages;
  }
  /** Approximate pages within the ORIGINAL cue interval by text weight. No wall
   * clock or playing flag: pause is stable, seek recomputes, mode changes do not
   * restart a page. Dense intervals are flagged, never slowed/sped up here. */
  function selectCaptionPage(pages, input) {
      const timingKnown = Number.isFinite(input.start) && Number.isFinite(input.end)
          && input.start >= 0 && input.end > input.start;
      const total = pages.length;
      if (!total)
          return { index: 0, page: null, total: 0, timingKnown, dense: false };
      if (!timingKnown)
          return { index: 0, page: pages[0], total, timingKnown: false, dense: total > 1 };
      const duration = input.end - input.start;
      const progress = Number.isFinite(input.time) ? Math.min(1, Math.max(0, (input.time - input.start) / duration)) : 0;
      const weights = pages.map(page => Math.max(0.01, page.weight));
      const sum = weights.reduce((a, b) => a + b, 0);
      const minSeconds = bounded(input.minPageSeconds, 1.2, 0.1, 10);
      const dense = total > 1 && weights.some(weight => duration * weight / sum < minSeconds);
      let boundary = 0, index = total - 1;
      for (let i = 0; i < total; i++) {
          boundary += weights[i] / sum;
          if (progress < boundary) {
              index = i;
              break;
          }
      }
      return { index, page: pages[index], total, timingKnown, dense };
  }
  
  const api = { captionTextWeight, splitCaptionPages, selectCaptionPage, BATCH_SIZE, serverOrigin, youtubeUrl, validCue, currentCues, batchAt, nextRequest, fullRequest, prefetchProgress, bilingualSrt, isLocalProcessing, isUnlimitedLocal, translationLimit, limitReached, boundedSettings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  scope.WatchCore = api;
})(globalThis);
