# Prism

A Chrome extension that filters your X (Twitter) feed with a language model, using rules
you write in plain English, e.g. "hide rage bait, engagement bait and low-effort dunks."
It also removes ads and keeps private stats on what you've scrolled.

The default backend is Chrome's built-in Gemini Nano, which runs entirely on your device.
OpenAI and Anthropic models are optional, with your own API key.

## Install

No build step. Requires Chrome 138+.

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repo folder.
3. Click the Prism toolbar icon to open its settings:
   - **Model**: Chrome built-in (click **Download model** the first time; a few GB, and Chrome
     wants ~22 GB free disk), or OpenAI / Anthropic with an API key.
   - **Filter rules**: what to hide. **Try it** tests the rules against a single post.
4. Open x.com. Filtered posts are blurred (or collapsed) with a "Filtered" label; click one to
   show it. Options can add the author's @handle and the model's reason to the label.
   The toolbar badge counts filtered posts in the tab, or shows `!` if the model failed.

## Models

| Provider | Default model | Where tweets go | Tweets/request | Requests in flight |
|---|---|---|---|---|
| Chrome built-in | Gemini Nano | nowhere (on-device) | 1 | 1 |
| OpenAI | `gpt-5.6-luna`, reasoning `none` | OpenAI (`store: false`) | 4 | 3 |
| Anthropic | `claude-haiku-4-5`, reasoning off | Anthropic | 4 | 3 |

Any OpenAI or Anthropic text model can be typed into the Model field. Reasoning effort is
translated per model (e.g. a thinking budget for Claude Haiku 4.5, adaptive thinking + effort
for newer Claude models, `reasoning.effort` for OpenAI reasoning models). Models without native
structured output fall back to JSON-in-the-prompt automatically.

Batching trades judgment for throughput: on a 35-tweet sample, Nano at 4 tweets/request missed
obvious rage bait, and `gpt-5.6-luna` at 8/request filtered posts the rules don't mention.

## Privacy

- Settings, API keys, the verdict cache and stats live in `chrome.storage.local` on your machine.
- With Chrome built-in, nothing leaves your device. With OpenAI or Anthropic, posts on your
  screen, plus the ones your timeline has already loaded just ahead of you, are sent to that
  provider (handle, text and quoted text only) for classification.
- There is no server, analytics or telemetry.

## How it works

```
x.com page                                   extension
─────────────────────────────                ─────────────────────────────────────────
intercept.js (MAIN world)                    background.js (service worker)
  hooks XHR/fetch, pulls tweets out of         queue, batching, verdict cache,
  X's GraphQL responses  ── postMessage ─┐     badge; routes to the provider
                                         │          │
content.js (isolated world)  ◀───────────┘          │ runsIn: 'offscreen'
  finds <article>s, asks for verdicts  ── runtime ──┤
  (on-screen first), applies blur/collapse ◀── msg ─┤
                                                    ▼
                                             offscreen.js hosts providers that need a
                                             window context (LanguageModel isn't exposed
                                             in extension service workers)
```

- **Tweet data** is captured from X's own API responses. Timelines (home, lists, profiles,
  threads) are classified ahead of time, so verdicts are usually ready before you scroll to
  them; anything else is classified once it's on screen. Tweets not seen on the network fall
  back to DOM scraping.
- **Ads** (promoted tweets) are always removed from the timeline, without a model call.
- **Fail open**: errors show the tweet. Rate limits and other transient errors are retried a
  couple of times first, with a small spinner on the post while it waits. Media-only tweets
  are never filtered.
- **Cache**: verdicts are cached by tweet id; changing the rules or model clears the cache.
- **Stats** (settings page → *Your feed*): posts seen per day (any part on screen, counted
  once per day), how many were filtered, ads removed, and a per-account breakdown.

## Adding a provider

Create `src/providers/<name>.js` implementing the interface documented in
`src/providers/index.js`, then add it to the `PROVIDERS` list there. A provider only turns
`{ system, prompt, schema }` into parsed JSON; prompt building and response parsing live in
`src/classify.js`. It also declares its `batchSize`, `concurrency` and `configFields`
(rendered on the settings page). Remote APIs need their host in `host_permissions`.

## License

[MIT](LICENSE)
