// OpenAI Responses API. Tweets are sent to OpenAI (with store: false).
// https://developers.openai.com/api/docs/guides/structured-outputs
import { extractJSON, jsonInstruction, postJSON, rejectsStructuredOutput } from './http.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.6-luna';
// Reasoning models accept reasoning.effort; others (gpt-4.1, gpt-4o, ...) reject it.
const REASONING = /^(gpt-5|gpt-6|o\d)/;

// Models that returned 400 for json_schema output; they get JSON-in-the-prompt instead.
const noStructuredOutput = new Set();

export default {
  id: 'openai',
  label: 'OpenAI',
  runsIn: 'worker',
  batchSize: 4,
  concurrency: 3,
  configFields: [
    { key: 'apiKey', label: 'API key', type: 'password' },
    { key: 'model', label: 'Model', placeholder: DEFAULT_MODEL },
    {
      key: 'reasoningEffort',
      label: 'Reasoning effort (reasoning models only)',
      type: 'select',
      default: 'none',
      // Not every model supports every level (e.g. gpt-5 has "minimal" but not "none");
      // an unsupported choice shows up as an API error on the status line.
      options: [
        ['none', 'None (fastest, cheapest)'],
        ['minimal', 'Minimal'],
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['xhigh', 'Extra high'],
        ['default', 'Model default'],
      ],
    },
  ],

  async status(config) {
    return config.apiKey ? { state: 'ready' } : { state: 'needs-config', detail: 'Add an OpenAI API key below.' };
  },

  async generate({ system, prompt, schema }, config) {
    if (!config.apiKey) throw new Error('No OpenAI API key set');
    const model = config.model || DEFAULT_MODEL;
    const effort = config.reasoningEffort || 'none';
    const structured = !noStructuredOutput.has(model);

    const { status, body } = await postJSON(
      ENDPOINT,
      { authorization: `Bearer ${config.apiKey}` },
      {
        model,
        instructions: structured ? system : system + jsonInstruction(schema),
        input: prompt,
        ...(REASONING.test(model) && effort !== 'default' ? { reasoning: { effort } } : {}),
        ...(structured ? { text: { format: { type: 'json_schema', name: 'verdicts', schema, strict: true } } } : {}),
        store: false,
      },
    );
    if (status !== 200) {
      const message = body?.error?.message ?? `HTTP ${status}`;
      if (structured && rejectsStructuredOutput(status, message)) {
        noStructuredOutput.add(model);
        return this.generate({ system, prompt, schema }, config);
      }
      throw new Error(`OpenAI ${status}: ${message}`);
    }

    // Truncated (max_output_tokens) or filtered responses may carry partial, unparseable JSON.
    if (body.status === 'incomplete') {
      throw new Error(`OpenAI response incomplete: ${body.incomplete_details?.reason ?? 'unknown reason'}`);
    }
    const content = body.output?.find((item) => item.type === 'message')?.content ?? [];
    const refusal = content.find((c) => c.type === 'refusal');
    if (refusal) throw new Error(`OpenAI refused: ${refusal.refusal}`);
    const text = content.find((c) => c.type === 'output_text')?.text;
    if (!text) throw new Error(`OpenAI returned no text (status: ${body.status})`);

    // input_tokens includes the cached ones; split them out so pricing can differ.
    const u = body.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const usage = { input: (u.input_tokens ?? 0) - cached, cached, cacheWrite: 0, output: u.output_tokens ?? 0 };
    return { result: structured ? JSON.parse(text) : extractJSON(text), model: body.model ?? model, usage };
  },
};
