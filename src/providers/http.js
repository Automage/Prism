// Shared helpers for remote (HTTP) providers.

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 2;
const MAX_WAIT_MS = 8000;

// POST JSON; retries rate limits and transient errors, honoring retry-after.
// Resolves to { status, body } for any non-retryable response, so callers can inspect 4xx errors.
export async function postJSON(url, headers, payload, { timeoutMs = 30_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (!RETRYABLE.has(res.status) || attempt >= MAX_RETRIES) return { status: res.status, body };
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, MAX_WAIT_MS)));
  }
}

// For models without native structured output: ask for JSON in the prompt instead.
export function jsonInstruction(schema) {
  return `\n\nRespond with only a JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(schema)}`;
}

// Parse the first JSON object in a model's text reply (tolerates code fences and preamble).
export function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`Model returned no JSON: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(start, end + 1));
}

// True when a 400 is about the structured-output parameter itself (not, say, an
// unsupported reasoning effort that happens to live in the same output_config object).
export const rejectsStructuredOutput = (status, message = '') =>
  status === 400 && /json_schema|output_config\.format|text\.format|response_format/i.test(message);
