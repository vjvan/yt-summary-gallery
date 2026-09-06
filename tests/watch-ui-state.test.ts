import test from 'node:test';
import assert from 'node:assert/strict';
import { getWatchConsentGate, getWatchProcessingCopy, watchUsageLabel, formatWatchLimit } from '../lib/watch/ui-state';

const ready = { demo: false, loading: false, stopped: false, sourceReady: true, modelEnabled: true, loadError: '' };

test('consent is available only when a real source and model are ready', () => {
  assert.equal(getWatchConsentGate(ready).canConsent, true);
  for (const patch of [{ demo: true }, { loading: true }, { stopped: true }, { sourceReady: false }, { modelEnabled: false }, { loadError: 'LOCAL_ONLY: 本機連線遭拒' }]) {
    assert.equal(getWatchConsentGate({ ...ready, ...patch }).canConsent, false);
  }
});

test('failed acquisition preserves original error next to disabled consent', () => {
  const loadError = '只允許本機同源請求（LOCAL_ONLY）';
  const gate = getWatchConsentGate({ ...ready, sourceReady: false, loadError });
  assert.equal(gate.state, 'failed');
  assert.equal(gate.description, loadError);
});

test('loading does not show a stale source failure and demo never appears enabled', () => {
  assert.equal(getWatchConsentGate({ ...ready, loading: true, loadError: 'old failure' }).state, 'loading');
  assert.equal(getWatchConsentGate({ ...ready, demo: true }).state, 'demo');
});

test('missing source, model configuration and stopped work each explain the next action', () => {
  assert.match(getWatchConsentGate({ ...ready, sourceReady: false }).description, /載入影片與原文/);
  assert.match(getWatchConsentGate({ ...ready, modelEnabled: false }).description, /不要把模型 API key/);
  assert.match(getWatchConsentGate({ ...ready, stopped: true }).description, /建立新的工作/);
});


test('local consent and usage have no API fee or total quota, including batch 51', () => {
  const info = { processingMode: 'local' as const, unlimited: true, translationModel: 'local-test', limits: { sessionCalls: null, dailyCalls: null } };
  const copy = getWatchProcessingCopy(info);
  assert.match(copy.banner, /全本機、不按批次收費/); assert.match(copy.consent, /每批 8 段/);
  assert.doesNotMatch(copy.consent, /可能產生 API 費用|每日最多/);
  assert.equal(watchUsageLabel(info, { session: 51, daily: 1000 }), '全本機 · 已處理 51 批 · 不限總批數');
  assert.match(getWatchConsentGate({ ...ready, ...info, modelEnabled: false, translationStatusMessage: '模型下載未完成' }).description, /模型下載未完成.*不會自動改用雲端/);
  assert.equal(formatWatchLimit(null), '不限'); assert.equal(formatWatchLimit(undefined), '待確認');
});
test('cloud consent and usage preserve finite spending safeguards', () => {
  const info = { processingMode: 'cloud' as const, unlimited: false, limits: { sessionCalls: 10, dailyCalls: 100 } };
  assert.match(getWatchProcessingCopy(info).consent, /可能產生 API 費用；本次最多 10 次、每日最多 100 次/);
  assert.equal(watchUsageLabel(info, { session: 3, daily: 10 }), '本次 3/10 · 今日 10/100');
});
