/** Transcript following never calls scrollIntoView: only the supplied panel may move. */
export type TranscriptFollowAction = 'manual-scroll' | 'resume' | 'cue-seek' | 'new-video' | 'playback-update';
export function nextTranscriptFollowState(enabled: boolean, action: TranscriptFollowAction): boolean {
  if (action === 'manual-scroll') return false;
  if (action === 'resume' || action === 'cue-seek' || action === 'new-video') return true;
  return enabled;
}
export interface TranscriptFollowGeometry {
  scrollTop: number; clientHeight: number; scrollHeight: number; cueTop: number; cueHeight: number;
}
export function transcriptFollowTop(geometry: TranscriptFollowGeometry, force = false): number | null {
  const { scrollTop, clientHeight, scrollHeight, cueTop, cueHeight } = geometry;
  if (![scrollTop, clientHeight, scrollHeight, cueTop, cueHeight].every(Number.isFinite)
    || clientHeight <= 0 || cueHeight <= 0 || scrollHeight <= clientHeight) return null;
  const inset = Math.min(24, clientHeight * 0.08);
  const viewportTop = scrollTop + inset;
  const viewportEnd = scrollTop + clientHeight - inset;
  const oversized = cueHeight > clientHeight - 2 * inset;
  const visible = oversized
    ? cueTop >= scrollTop && cueTop < viewportEnd
    : cueTop >= viewportTop && cueTop + cueHeight <= viewportEnd;
  if (!force && visible) return null;
  // Keep the current sentence near the upper third, with room for subsequent lines.
  const desired = cueTop - (oversized ? inset : Math.max(inset, (clientHeight - cueHeight) * 0.35));
  const bounded = Math.max(0, Math.min(scrollHeight - clientHeight, desired));
  return Math.abs(bounded - scrollTop) < 1 ? null : bounded;
}
interface TranscriptPanel {
  scrollTop: number; clientHeight: number; scrollHeight: number; clientTop: number;
  getBoundingClientRect(): { top: number };
  scrollTo(options: { top: number; behavior: 'auto' }): void;
}
interface TranscriptRow { getBoundingClientRect(): { top: number; height: number } }
export function followTranscriptCue(panel: TranscriptPanel, row: TranscriptRow, enabled: boolean, force = false): boolean {
  if (!enabled) return false;
  const rect = row.getBoundingClientRect();
  const top = transcriptFollowTop({
    scrollTop: panel.scrollTop, clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight,
    cueTop: rect.top - panel.getBoundingClientRect().top - panel.clientTop + panel.scrollTop, cueHeight: rect.height,
  }, force);
  if (top === null) return false;
  panel.scrollTo({ top, behavior: 'auto' });
  return true;
}
