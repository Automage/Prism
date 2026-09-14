# Prism

A Chrome extension that filters your X feed with a language model, using rules
you write in plain English. It also removes ads and shows usage statistics.

The default model is OpenAI's `gpt-5.6-luna` (bring your own API key). Anthropic models and
Chrome's built-in Gemini Nano, which runs entirely on your device, are also supported.

<p>
  <img src="docs/feed.png" alt="Filtered posts collapsed on the X timeline, each labeled with the author's handle and the model's reason" width="100%">
</p>

<p>
  <img src="docs/settings.png" alt="Prism settings: model, API key, reasoning effort and filter rules" width="49%">
  <img src="docs/stats.png" alt="Prism settings: display options, Try it, and feed stats" width="49%">
</p>

## Install

No build step. Requires Chrome 138+.

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repo folder.
3. Click the Prism toolbar icon to open its settings:
   - **Model**: OpenAI (default) or Anthropic with an API key, or Chrome built-in (click
     **Download model** the first time; a few GB, and Chrome wants ~22 GB free disk).
   - **Filter rules**: what to hide. **Try it** tests the rules against a single post.
     **Always show** lists accounts (e.g. `@paulg`) whose posts are never filtered.
4. Open x.com. Filtered posts are blurred (or collapsed) with a "Filtered" label; click one to
   show it. Options can add the author's @handle and the model's reason to the label.
   The toolbar badge counts filtered posts in the tab, or shows `!` if the model failed.

## Privacy

- There is no server, analytics or telemetry.
- Settings, API keys, the verdict cache and stats live in `chrome.storage.local` on your machine.
- Every post sent to the model is logged (text, author, which of your accounts was logged in,
  verdict, reason, model, cost) to IndexedDB on your machine, with no size or age limit. The
  settings page can export it as JSONL or clear it.
- With Chrome built-in, nothing leaves your device. With OpenAI or Anthropic, posts on your
  screen, plus the ones your timeline has already loaded just ahead of you, are sent to that
  provider (handle, text and quoted text only) for classification.

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
- **Whitelist**: posts by listed accounts are shown without a model call (for a retweet, the
  original author is what counts). Ads from them are still removed.
- **Fail open**: errors show the tweet. Rate limits and other transient errors are retried a
  couple of times first, with a small spinner on the post while it waits. Media-only tweets
  are never filtered.
- **Cache**: verdicts are cached by tweet id; changing the rules or model clears the cache.
- **Stats** (settings page → *Your feed*): posts seen per day (any part on screen, counted
  once per day per logged-in account), how many were filtered, and ads removed. If you use
  more than one X account, a picker shows the numbers for one account or all of them. The
  logged-in handle is read from the page's own navigation, never from cookies.
- **Cost**: providers report token usage per request; `src/pricing.js` turns it into dollars
  from a list-price table. Spend shows as a tile (period total, plus today), in the chart
  tooltip and in the day table. A model missing from the table counts tokens but not dollars,
  and the tile says how many requests went unpriced. Only Prism's own requests are counted.
- **Log** (settings page → *Log*): one row per post sent to the model, in IndexedDB. Ads,
  whitelisted and media-only posts never reach the model so aren't logged; cache hits aren't
  logged again. Export as JSONL for `jq` or pandas, or clear it.


## License

[MIT](LICENSE)
