import { PROVIDERS } from './providers/index.js';
import { DEFAULT_POLICY, getSettings } from './settings.js';
import { initStats } from './stats-view.js';

const $ = (id) => document.getElementById(id);
const set = (values) => chrome.storage.local.set(values);

const STATE_LABELS = {
  ready: 'Ready',
  'needs-config': 'Needs configuration',
  'needs-download': 'Model needs to be downloaded',
  downloading: 'Downloading model…',
  unavailable: 'Unavailable',
};

let settings = await getSettings();

// ---------- controls ----------

$('enabled').checked = settings.enabled;
$('enabled').addEventListener('change', (e) => set({ enabled: e.target.checked }));

for (const provider of Object.values(PROVIDERS)) {
  $('provider').append(new Option(provider.label, provider.id, false, provider.id === settings.provider));
}
$('provider').addEventListener('change', async (e) => {
  await set({ provider: e.target.value });
  settings = await getSettings();
  renderProviderConfig();
  refreshStatus();
});

// Provider-specific settings (API keys, model ids), declared by each provider's configFields.
// Saved on change rather than per keystroke: any providerConfig change clears the verdict cache.
function renderProviderConfig() {
  const provider = PROVIDERS[settings.provider];
  const values = settings.providerConfig[provider.id] ?? {};
  $('provider-config').replaceChildren(
    ...(provider.configFields ?? []).map((field) => {
      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        for (const [value, text] of field.options) input.append(new Option(text, value));
        input.value = values[field.key] || field.default || field.options[0][0];
      } else {
        input = Object.assign(document.createElement('input'), {
          type: field.type ?? 'text',
          value: values[field.key] ?? '',
          placeholder: field.placeholder ?? '',
          autocomplete: 'off',
          spellcheck: false,
        });
      }
      input.addEventListener('change', async () => {
        const providerConfig = { ...settings.providerConfig, [provider.id]: { ...values, [field.key]: input.value.trim() } };
        await set({ providerConfig });
        settings = await getSettings();
        renderProviderConfig();
        refreshStatus();
      });
      const label = Object.assign(document.createElement('label'), { className: 'field' });
      label.append(Object.assign(document.createElement('span'), { textContent: field.label }), input);
      return label;
    }),
  );
}
renderProviderConfig();

$('policy').value = settings.policy;
$('save').addEventListener('click', async () => {
  await set({ policy: $('policy').value });
  $('saved').hidden = false;
  setTimeout(() => ($('saved').hidden = true), 2500);
});
$('reset').addEventListener('click', () => {
  $('policy').value = DEFAULT_POLICY;
});

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.checked = radio.value === settings.mode;
  radio.addEventListener('change', () => set({ mode: radio.value }));
}
$('holdPending').checked = settings.holdPending;
$('holdPending').addEventListener('change', (e) => set({ holdPending: e.target.checked }));
for (const key of ['showHandle', 'showReasons']) {
  $(key).checked = settings[key];
  $(key).addEventListener('change', (e) => set({ [key]: e.target.checked }));
}

// ---------- model status ----------

let pollTimer = null;

async function refreshStatus() {
  clearTimeout(pollTimer);
  const status = (await chrome.runtime.sendMessage({ type: 'status' })) ?? { state: 'unavailable', detail: 'Background did not respond.' };
  $('status-dot').className = `dot ${status.state}`;
  $('status-text').textContent = STATE_LABELS[status.state] ?? status.state;
  const detail = status.lastError ? `Last error: ${status.lastError}` : status.detail;
  $('status-detail').hidden = !detail;
  $('status-detail').textContent = detail ?? '';
  $('download').hidden = !(status.state === 'needs-download' && PROVIDERS[settings.provider]?.prepare);
  if (status.state === 'downloading') pollTimer = setTimeout(refreshStatus, 2000);
}

// Runs here rather than in the background because downloading the on-device
// model requires a user gesture, which only a page like this one can provide.
$('download').addEventListener('click', async () => {
  const provider = PROVIDERS[settings.provider];
  $('download').disabled = true;
  $('progress').hidden = false;
  $('status-text').textContent = STATE_LABELS.downloading;
  try {
    await provider.prepare(settings.providerConfig[provider.id] ?? {}, {
      onProgress: (fraction) => ($('progress').value = fraction),
    });
  } catch (err) {
    $('status-detail').hidden = false;
    $('status-detail').textContent = `Download failed: ${err?.message ?? err}`;
  } finally {
    $('download').disabled = false;
    $('progress').hidden = true;
    refreshStatus();
  }
});

refreshStatus();
initStats();

// ---------- try it ----------

$('test').addEventListener('click', async () => {
  const text = $('test-text').value.trim();
  if (!text) return;
  $('test').disabled = true;
  const out = $('test-result');
  out.hidden = false;
  out.textContent = 'Classifying…';
  const result = (await chrome.runtime.sendMessage({ type: 'test', text, policy: $('policy').value }).catch(() => null)) ?? {
    error: 'The background worker did not respond. Try reloading the extension.',
  };
  $('test').disabled = false;
  out.replaceChildren();
  if (result.error) {
    out.textContent = `Error: ${result.error}`;
    return;
  }
  const verdict = Object.assign(document.createElement('span'), {
    className: `verdict ${result.verdict}`,
    textContent: result.verdict.toUpperCase(),
  });
  const details = document.createElement('details');
  details.append(
    Object.assign(document.createElement('summary'), { textContent: 'Raw model output' }),
    Object.assign(document.createElement('pre'), { textContent: JSON.stringify(result.raw, null, 2) }),
  );
  out.append(verdict, ` · ${result.reason || 'no reason given'} · ${result.ms} ms`, details);
});
