// List prices in USD per 1M tokens, checked 2026-09-14 against
// https://developers.openai.com/api/docs/pricing and
// https://platform.claude.com/docs/en/about-claude/pricing
//
// { input, cached, output } — `input` is uncached input, `cached` is cache reads.
// Anthropic cache writes cost 1.25x input (5-minute cache); Prism never asks for them.
// A model is matched by the longest key that equals it or is a prefix of it up to a
// dash, so dated ids like gpt-5-2025-08-07 or claude-haiku-4-5-20251001 still match.

const PRICES = {
  openai: {
    'gpt-6-astra': { input: 10, cached: 1, output: 50 },
    'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
    'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
    'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
    'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
    'gpt-5.5-pro': { input: 30, cached: 30, output: 180 },
    'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
    'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
    'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
    'gpt-5.4-pro': { input: 30, cached: 30, output: 180 },
    'gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
    'gpt-5.2-pro': { input: 21, cached: 21, output: 168 },
    'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
    'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
    'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
    'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
    'gpt-5-pro': { input: 15, cached: 15, output: 120 },
    'gpt-4.1': { input: 2, cached: 0.5, output: 8 },
    'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
    'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
    'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
    o3: { input: 2, cached: 0.5, output: 8 },
    'o3-mini': { input: 1.1, cached: 0.55, output: 4.4 },
    'o4-mini': { input: 1.1, cached: 0.275, output: 4.4 },
  },
  anthropic: {
    'claude-fable-5-1': { input: 10, cached: 0.25, output: 50 },
    'claude-mythos-5-1': { input: 10, cached: 0.25, output: 50 },
    'claude-fable-5': { input: 10, cached: 1, output: 50 },
    'claude-mythos-5': { input: 10, cached: 1, output: 50 },
    'claude-opus-5': { input: 5, cached: 0.5, output: 25 },
    'claude-opus-4-8': { input: 5, cached: 0.5, output: 25 },
    'claude-opus-4-7': { input: 5, cached: 0.5, output: 25 },
    'claude-opus-4-6': { input: 5, cached: 0.5, output: 25 },
    'claude-opus-4-5': { input: 5, cached: 0.5, output: 25 },
    'claude-opus-4-1': { input: 15, cached: 1.5, output: 75 },
    'claude-opus-4': { input: 15, cached: 1.5, output: 75 },
    'claude-sonnet-5': { input: 2, cached: 0.2, output: 10 },
    'claude-sonnet-4-6': { input: 3, cached: 0.3, output: 15 },
    'claude-sonnet-4-5': { input: 3, cached: 0.3, output: 15 },
    'claude-sonnet-4': { input: 3, cached: 0.3, output: 15 },
    'claude-3-7-sonnet': { input: 3, cached: 0.3, output: 15 },
    'claude-3-5-sonnet': { input: 3, cached: 0.3, output: 15 },
    'claude-haiku-4-5': { input: 1, cached: 0.1, output: 5 },
    'claude-haiku-3-5': { input: 0.8, cached: 0.08, output: 4 },
    'claude-3-5-haiku': { input: 0.8, cached: 0.08, output: 4 },
  },
  'chrome-builtin': { 'gemini-nano': { input: 0, cached: 0, output: 0 } }, // on-device, free
};

export function priceOf(provider, model = '') {
  const table = PRICES[provider];
  if (!table) return null;
  let best = null;
  for (const key of Object.keys(table)) {
    if ((model === key || model.startsWith(`${key}-`)) && (best === null || key.length > best.length)) best = key;
  }
  return best === null ? null : table[best];
}

// usage: { input, cached, cacheWrite, output } token counts. Returns USD, or null if the
// model isn't in the table.
export function costOf(provider, model, usage) {
  const price = priceOf(provider, model);
  if (!price) return null;
  const u = usage ?? {};
  const per = (n, rate) => ((n ?? 0) * rate) / 1e6;
  return per(u.input, price.input) + per(u.cached, price.cached) + per(u.cacheWrite, price.input * 1.25) + per(u.output, price.output);
}
