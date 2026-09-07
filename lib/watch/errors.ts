/** Only these fixed reasons may cross the model → API → persisted UI boundary. */
export const LOCAL_QUALITY_REASONS = {
  INVALID_JSON: '模型未回傳有效 JSON',
  INVALID_FORMAT: '譯文格式無效',
  EMPTY_TEXT: '譯文空白或格式無效',
  NOT_CHINESE: '譯文未產生繁中，未把原文當作成功',
  UNTRANSLATED_ENGLISH: '仍含未翻譯的一般英文',
  PROTECTED_TERMS: '未保留指定專有名詞或其出現次數',
  SOURCE_NUMBERS: '修復譯文未完整保留原文數字',
  OUTPUT_LIMIT: '輸出達到安全長度上限，尚未完整完成',
  INCOMPLETE_GENERATION: '模型生成仍未完整完成，未採用部分譯文',
  UNKNOWN: '譯文未通過品質檢查',
} as const;
export type LocalQualityReason = keyof typeof LOCAL_QUALITY_REASONS;
export function safeLocalQualityReason(value: unknown): LocalQualityReason {
  return typeof value === 'string' && Object.hasOwn(LOCAL_QUALITY_REASONS, value) ? value as LocalQualityReason : 'UNKNOWN';
}
export class WatchError extends Error {
  constructor(public code: string, message: string, public status = 400, public qualityReason?: LocalQualityReason) {
    super(message);
    this.name = 'WatchError';
  }
}
