import type { LearningProfileSnapshot } from './types';
/** Only the goals authorized in this conversation. No disk/vault/user-profile retrieval. */
export function authorizedLearningProfile(): LearningProfileSnapshot {
  return { version: 'conversation-goals-v1', source: 'user-authorized-this-conversation', goals: [
    'AI 影片製作', '建立可重複使用的工作流程', '影像編輯', '教學與服務中高齡企業主',
  ] };
}
