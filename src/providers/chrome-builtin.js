// Chrome's on-device model (Gemini Nano) via the Prompt API.
// https://developer.chrome.com/docs/ai/prompt-api

const LANGUAGE_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

// A base session primed with the system prompt; each request runs on a clone of it
// so the rules are only prefilled once and batches don't see each other's tweets.
let base = null;
let baseSystem = null;
let pending = null;

async function createSession(options) {
  try {
    // Near-greedy sampling: classification should be repeatable.
    return await LanguageModel.create({ ...options, temperature: 0, topK: 1 });
  } catch (err) {
    if (err?.name !== 'NotSupportedError' && !(err instanceof RangeError) && !(err instanceof TypeError)) throw err;
    return LanguageModel.create(options);
  }
}

async function baseSession(system) {
  if (base && baseSystem === system) return base;
  if (pending) {
    await pending;
    return baseSession(system);
  }
  pending = (async () => {
    base?.destroy();
    base = null;
    base = await createSession({ ...LANGUAGE_OPTIONS, initialPrompts: [{ role: 'system', content: system }] });
    baseSystem = system;
  })();
  try {
    await pending;
  } finally {
    pending = null;
  }
  return base;
}

export default {
  id: 'chrome-builtin',
  label: 'Chrome built-in (Gemini Nano, on-device)',
  runsIn: 'offscreen',
  batchSize: 1,

  async status() {
    if (typeof LanguageModel === 'undefined') {
      return { state: 'unavailable', detail: 'The Prompt API (LanguageModel) is not exposed in this browser.' };
    }
    const availability = await LanguageModel.availability(LANGUAGE_OPTIONS);
    switch (availability) {
      case 'available':
        return { state: 'ready' };
      case 'downloadable':
        return { state: 'needs-download' };
      case 'downloading':
        return { state: 'downloading' };
      default:
        return { state: 'unavailable', detail: `LanguageModel.availability() returned "${availability}" (unsupported hardware, low disk space, or disabled by policy).` };
    }
  },

  async prepare(_config, { onProgress } = {}) {
    const session = await LanguageModel.create({
      ...LANGUAGE_OPTIONS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded));
      },
    });
    session.destroy();
  },

  async generate({ system, prompt, schema }) {
    const session = await (await baseSession(system)).clone();
    try {
      return JSON.parse(await session.prompt(prompt, { responseConstraint: schema }));
    } finally {
      session.destroy();
    }
  },
};
