// Hosts providers with runsIn: 'offscreen'. Offscreen documents are real window
// contexts that outlive service-worker restarts, so the model session stays warm.
import { PROVIDERS } from './providers/index.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  const provider = PROVIDERS[msg.provider];
  Promise.resolve()
    .then(() => {
      if (!provider || typeof provider[msg.method] !== 'function') {
        throw new Error(`Unknown provider method ${msg.provider}.${msg.method}`);
      }
      return provider[msg.method](...msg.args);
    })
    .then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: err?.message ?? String(err) }),
    );
  return true;
});
