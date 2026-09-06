// Run against the built local server. No model or audio calls; never print tokens.
import assert from 'node:assert/strict';
const port = Number(process.argv[2] || 3000);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
for (const host of ['127.0.0.1', 'localhost']) {
  const origin = `http://${host}:${port}`;
  const paired = await fetch(`${origin}/api/watch/pair`, {headers:{Origin:origin}});
  assert.equal(paired.status,200,`${host}: pairing must work in Next production`);
  const {token} = await paired.json();
  assert.match(token,/^[a-f0-9]{64}$/);
  const auth = {Authorization:`Bearer ${token}`,Origin:origin};
  const status = await fetch(`${origin}/api/watch/status`,{headers:auth});
  assert.equal(status.status,200);
  const health = await status.json();
  assert.equal(health.version,3);
  assert.ok(['local','cloud'].includes(health.processingMode));
  assert.equal(health.unlimited, health.processingMode === 'local');
  assert.equal(typeof health.translationConfigured,'boolean');
  assert.equal(typeof health.audioConfigured,'boolean');
  // An invalid source must reach validation, not be rejected as a non-local caller.
  const invalid = await fetch(`${origin}/api/watch/session`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({url:'invalid'})});
  assert.equal(invalid.status,400);
  const forbidden = await fetch(`${origin}/api/watch/pair`,{headers:{Origin:'https://www.youtube.com'}});
  assert.equal(forbidden.status,403);
  const extension = `chrome-extension://${'b'.repeat(32)}`;
  const extensionStatus = await fetch(`${origin}/api/watch/status`,{headers:{...auth,Origin:extension}});
  assert.equal(extensionStatus.status,200);
  assert.equal(extensionStatus.headers.get('Access-Control-Allow-Origin'),extension);
  // Explicitly deny consent: this must never create an audio session or call a model.
  const noAudioConsent = await fetch(`${origin}/api/watch/audio/session`, {method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({url:'https://www.youtube.com/watch?v=kfbWz9_bJoA',maxChunks:2,confirmAudio:false})});
  assert.equal(noAudioConsent.status,403);
  assert.equal((await noAudioConsent.json()).code,'AUDIO_CONSENT_REQUIRED');
  const invalidAudio = await fetch(`${origin}/api/watch/audio/chunk`, {method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}'});
  assert.equal(invalidAudio.status,415);
  const preflight = await fetch(`${origin}/api/watch/audio/chunk`, {method:'OPTIONS',headers:{Origin:extension,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,prefer'}});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),extension);
  console.log(`${host}: pairing, authenticated status, input validation, hostile-Origin rejection, extension CORS, audio consent guard and upload validation passed; no paid requests.`);
}
