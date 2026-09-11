export const DEFAULT_POLICY = `Hide:
- Rage bait: posts written to provoke outrage, especially political or culture-war dunks.
- Engagement bait: "reply with your...", "like if...", vague teasers, bait questions.
- Snark, dunking or mocking specific people without adding information.
- Doom or fear-mongering with no concrete facts.
- Low-effort reactions: emoji-only, "lol", "this", "huge if true".

Keep everything else, including strong opinions backed by real arguments, news, data, and technical content.`;

export const DEFAULTS = {
  enabled: true,
  provider: 'openai',
  providerConfig: {}, // per-provider options (API keys, model ids), keyed by provider id
  policy: DEFAULT_POLICY,
  mode: 'blur', // 'blur' | 'collapse'
  holdPending: true, // blur tweets until they've been classified
  showReasons: false, // show the model's reason on filtered posts, not just "Filtered"
  showHandle: false, // show the author's @handle on filtered posts
};

export async function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

// Settings that change which verdict a tweet gets; changing any of these invalidates the cache.
export const VERDICT_KEYS = ['provider', 'providerConfig', 'policy'];
