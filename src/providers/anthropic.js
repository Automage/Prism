// Anthropic Messages API.
// https://platform.claude.com/docs/en/api/messages
import { extractJSON, jsonInstruction, postJSON, rejectsStructuredOutput } from './http.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5';

// Pre-4.6 models take a thinking token budget; newer ones use adaptive thinking + effort.
const BUDGET_THINKING = /claude-3|claude-(haiku|sonnet|opus)-4-[0-5](\b|-)|claude-(sonnet|opus)-4-20\d{6}/;
// Fable/Mythos always think; thinking can't be disabled there.
const ALWAYS_THINKS = /claude-(fable|mythos)/;
// Models that support server-side refusal fallbacks.
const REFUSAL_FALLBACKS = /claude-(opus-5|fable-5-1)(\b|-)/;
const BUDGETS = { low: 1024, medium: 4096, high: 8192, xhigh: 16000, max: 32000 };

// Models that returned 400 for output_config.format; they get JSON-in-the-prompt instead.
const noStructuredOutput = new Set();

// Structured outputs reject numeric, string-length and array-length constraints.
function stripUnsupported(schema) {
  if (Array.isArray(schema)) return schema.map(stripUnsupported);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf'].includes(k)) continue;
    out[k] = stripUnsupported(v);
  }
  return out;
}

function thinkingParams(model, effort) {
  if (BUDGET_THINKING.test(model)) {
    if (effort === 'off') return { max_tokens: 1024 };
    const budget = BUDGETS[effort] ?? BUDGETS.low;
    return { max_tokens: budget + 2048, thinking: { type: 'enabled', budget_tokens: budget } };
  }
  if (effort === 'off') {
    return ALWAYS_THINKS.test(model)
      ? { max_tokens: 16000, output_config: { effort: 'low' } }
      : { max_tokens: 1024, thinking: { type: 'disabled' } };
  }
  return {
    max_tokens: 16000,
    ...(ALWAYS_THINKS.test(model) ? {} : { thinking: { type: 'adaptive' } }),
    output_config: { effort },
  };
}

export default {
  id: 'anthropic',
  label: 'Anthropic',
  runsIn: 'worker',
  batchSize: 4,
  concurrency: 3,
  configFields: [
    { key: 'apiKey', label: 'API key', type: 'password' },
    { key: 'model', label: 'Model', placeholder: DEFAULT_MODEL },
    {
      key: 'reasoningEffort',
      label: 'Reasoning effort',
      type: 'select',
      default: 'off',
      options: [
        ['off', 'Off (fastest, cheapest)'],
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['xhigh', 'Extra high (newer models)'],
        ['max', 'Max'],
      ],
    },
  ],

  async status(config) {
    return config.apiKey ? { state: 'ready' } : { state: 'needs-config', detail: 'Add an Anthropic API key below.' };
  },

  async generate({ system, prompt, schema }, config) {
    if (!config.apiKey) throw new Error('No Anthropic API key set');
    const model = config.model || DEFAULT_MODEL;
    const params = thinkingParams(model, config.reasoningEffort || 'off');
    const structured = !noStructuredOutput.has(model);
    const fallbacks = REFUSAL_FALLBACKS.test(model);

    const headers = {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for requests from a browser context; the key never leaves this extension.
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(fallbacks ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
    };
    const payload = {
      model,
      ...params,
      system: structured ? system : system + jsonInstruction(schema),
      messages: [{ role: 'user', content: prompt }],
      ...(structured
        ? { output_config: { ...params.output_config, format: { type: 'json_schema', schema: stripUnsupported(schema) } } }
        : {}),
      ...(fallbacks ? { fallbacks: 'default' } : {}),
    };

    const { status, body } = await postJSON(ENDPOINT, headers, payload);
    if (status !== 200) {
      const message = body?.error?.message ?? `HTTP ${status}`;
      if (structured && rejectsStructuredOutput(status, message)) {
        noStructuredOutput.add(model);
        return this.generate({ system, prompt, schema }, config);
      }
      throw new Error(`Anthropic ${status}: ${message}`);
    }
    if (body.stop_reason === 'refusal') throw new Error('Anthropic declined to classify this batch');
    if (body.stop_reason === 'max_tokens') throw new Error('Anthropic response hit max_tokens');
    const text = body.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';

    // input_tokens is uncached input only; cache reads and writes are reported separately.
    const u = body.usage ?? {};
    const usage = {
      input: u.input_tokens ?? 0,
      cached: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
    return { result: structured ? JSON.parse(text) : extractJSON(text), model: body.model ?? model, usage };
  },
};
