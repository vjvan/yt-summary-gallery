import type { LiveReplyDraft, LiveReplyInput, LiveSessionMetadata, LiveTone } from '../live/types';

export const MAX_REPLY_CHARACTERS = 1200;
export function liveTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}
export function liveSourceHost(url: string): string {
  try { const host = new URL(url).hostname; return ['discord.com', 'www.discord.com'].includes(host) ? host : 'Discord'; }
  catch { return 'Discord'; }
}
export function chooseLiveSession(sessions: LiveSessionMetadata[], current: string, preferred = ''): string {
  if (sessions.some(session => session.sessionId === current)) return current;
  if (sessions.some(session => session.sessionId === preferred)) return preferred;
  return sessions.find(session => session.state === 'active')?.sessionId || sessions[0]?.sessionId || '';
}
export function followLiveTranscript(panel: { scrollTop: number; clientHeight: number; scrollHeight: number; scrollTo: (options: { top: number; behavior: 'auto' }) => void }, following: boolean): boolean {
  if (!following || ![panel.scrollTop, panel.clientHeight, panel.scrollHeight].every(Number.isFinite) || panel.clientHeight <= 0) return false;
  const top = Math.max(0, panel.scrollHeight - panel.clientHeight);
  if (Math.abs(top - panel.scrollTop) < 1) return false;
  panel.scrollTo({ top, behavior: 'auto' }); return true;
}
export function makeLiveReplyInput(sessionId: string, text: string, tone: LiveTone): LiveReplyInput {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw Error('請先選擇有效的直播來源。');
  const clean = text.trim();
  if (!clean || clean.length > MAX_REPLY_CHARACTERS || !/[\u3400-\u9fff]/.test(clean)) throw Error(`請輸入 1–${MAX_REPLY_CHARACTERS} 字、包含中文的回覆草稿。`);
  if (!['natural', 'polite', 'concise'].includes(tone)) throw Error('請選擇有效的回覆語氣。');
  return { sessionId, text: clean, tone };
}
/** A reply to an old source or an edited Chinese input must never replace the visible draft. */
export function mayApplyLiveDraft(draft: LiveReplyDraft, request: LiveReplyInput, current: { sessionId: string; text: string; generation: number }, requestedGeneration: number): boolean {
  return current.generation === requestedGeneration && current.sessionId === request.sessionId
    && current.text.trim() === request.text && draft.sessionId === request.sessionId
    && typeof draft.sourceText === 'string' && draft.sourceText.trim() === request.text
    && typeof draft.english === 'string' && Boolean(draft.english.trim());
}
export function liveSessionLabel(session: LiveSessionMetadata): string {
  if (session.status === 'error') return '收音已中斷';
  if (session.state === 'stopped') return '已停止收音';
  return session.audioProcessing ? '本機辨識／翻譯中' : '等待下一段音訊';
}
