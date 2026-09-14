// LLM backends. To add one, create a module that default-exports an object with
// this shape and register it below — nothing else needs to change.
//
// interface Provider {
//   id: string;
//   label: string;
//   // Where generate() runs. 'offscreen' for APIs that need a window context
//   // (Chrome's built-in model); 'worker' for plain fetch-based APIs.
//   runsIn: 'offscreen' | 'worker';
//   // How many tweets to put in one request, and how many requests may run at once.
//   batchSize: number;
//   concurrency?: number; // default 1
//   // Settings shown on the options page, stored in settings.providerConfig[id].
//   configFields?: Array<{ key: string, label: string, type?: 'text' | 'password' | 'select',
//                          placeholder?: string, options?: [value, label][], default?: string }>;
//   status(config): Promise<{ state: 'ready' | 'needs-config' | 'needs-download' | 'downloading' | 'unavailable', detail?: string }>;
//   // Optional one-time setup (model download, warm-up). Called from the options
//   // page inside a click handler, since some backends require user activation.
//   prepare?(config, { onProgress?: (fraction: number) => void }): Promise<void>;
//   // Return the model's reply parsed as JSON conforming to `schema`, the model id that
//   // actually served it, and token usage ({ input, cached, cacheWrite, output }; null
//   // when there is nothing to bill). `input` excludes cached tokens.
//   generate(request: { system: string, prompt: string, schema: object }, config):
//     Promise<{ result: object, model: string, usage: Usage | null }>;
// }
//
// `config` is settings.providerConfig[provider.id] (API keys, model names, ...).

import anthropic from './anthropic.js';
import chromeBuiltin from './chrome-builtin.js';
import openai from './openai.js';

export const PROVIDERS = Object.fromEntries([chromeBuiltin, openai, anthropic].map((p) => [p.id, p]));
