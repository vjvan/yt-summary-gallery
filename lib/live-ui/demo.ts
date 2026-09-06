import type { LiveSessionDetail } from '../live/types';

export const DEMO_REPLY_ZH = '謝謝你的說明。我們先測試人物遮罩，再一起確認攝影棚背景的光線是否自然。';
export const DEMO_REPLY_EN = 'Thanks for walking us through it. Let’s test the subject mask first, then check whether the studio lighting looks natural.';
export const LIVE_DEMO: LiveSessionDetail = {
  sessionId: 'discord-live-demo', url: 'https://discord.com/channels/demo/demo', title: '創作者交流室 · Weave 合成討論（示範）',
  source: 'discord', processingMode: 'local', unlimited: true, state: 'active', status: 'active',
  createdAt: 1788600000000, updatedAt: 1788600037000, nextSequence: 5, processing: false, audioProcessing: false, replyProcessing: false,
  translationModel: '本機模型 · 示範資料', limits: { maxChunkSeconds: 15, maxStoredChunks: 100, maxStoredCues: 500 },
  cues: [
    { id: 'live-demo-1', start: 0, end: 5, originalText: 'Let’s keep the subject and replace only the background.', text: '我們保留人物，只替換背景。' },
    { id: 'live-demo-2', start: 6, end: 12, originalText: 'The mask should preserve the hair and the moving fingers.', text: '遮罩要保留頭髮細節，以及正在移動的手指。' },
    { id: 'live-demo-3', start: 13, end: 19, originalText: 'Then connect the foreground to the Compositor node.', text: '接著，把前景接到 Compositor（合成器）節點。' },
    { id: 'live-demo-4', start: 20, end: 27, originalText: 'Use a soft key light so the person fits the new studio.', text: '使用柔和的主光，讓人物自然融入新的攝影棚場景。' },
    { id: 'live-demo-5', start: 28, end: 34, originalText: 'Could you show us the mask before you merge the layers?', text: '合併圖層之前，可以先讓我們看一下遮罩嗎？' },
  ],
  chunks: [{ sequence: 4, start: 28, end: 34, status: 'done', processingMs: 2800 }], gaps: [], drafts: [],
};
