// Isolated-world content script: finds tweets on screen, asks the background for
// verdicts, and blurs/collapses the ones that should be filtered.
(() => {
  const SOURCE = 'prism:tweets';
  // Any other setting change invalidates local verdicts. (For the whitelist that's cheap:
  // the background keeps its cache, so re-requested tweets come straight back.)
  const DISPLAY_KEYS = ['enabled', 'mode', 'holdPending', 'showReasons', 'showHandle'];
  const FLUSH_MS = 120;
  const STALE_MS = 60_000;
  const RETRY_MS = 10_000; // after a transient provider error (rate limit, 5xx, timeout)
  const MAX_ATTEMPTS = 3;
  const MAX_KNOWN = 5000;

  const known = new Map(); // tweetId -> tweet captured from X's API responses
  const verdicts = new Map(); // tweetId -> { verdict, reason }
  const requested = new Map(); // tweetId -> { at, priority }
  const attempts = new Map(); // tweetId -> number of timed-out requests
  const revealed = new Set(); // tweetIds the user clicked to show
  const outbox = { true: new Map(), false: new Map() }; // keyed by priority
  let settings = null;
  let whitelist = new Set(); // lowercase handles from settings.whitelist
  let viewerHandle = ''; // the logged-in X account, once found
  let alive = true;
  let flushTimer = null;
  let scanQueued = false;

  const KEEP = { verdict: 'keep', reason: '' };
  const AD = { verdict: 'filter', reason: 'Ad', ad: true }; // ads are always removed, no model call
  const WHITELISTED = { verdict: 'keep', reason: 'Whitelisted' }; // author is on the user's list, no model call

  // Matches the post's author (for a retweet, the original author), not who retweeted it.
  function whitelisted(tweet) {
    return whitelist.has((tweet.author || '').toLowerCase());
  }

  // ---------- messaging ----------

  function isDead(err) {
    return /context invalidated/i.test(err?.message ?? '');
  }

  // The extension was reloaded or removed: unblur everything and stop.
  function shutdown() {
    alive = false;
    observer.disconnect();
    visibility.disconnect();
    for (const article of document.querySelectorAll('article[data-ic]')) delete article.dataset.ic;
  }

  async function send(msg) {
    if (!alive) throw new Error('extension context invalidated');
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (isDead(err)) shutdown();
      throw err;
    }
  }

  function request(tweet, priority) {
    const prev = requested.get(tweet.id);
    if (verdicts.has(tweet.id) || (prev && (prev.priority || !priority))) return;
    requested.set(tweet.id, { at: Date.now(), priority });
    outbox[priority].set(tweet.id, tweet);
    flushTimer ??= setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    flushTimer = null;
    for (const priority of [true, false]) {
      const box = outbox[priority];
      if (!box.size) continue;
      const tweets = [...box.values()];
      box.clear();
      send({ type: 'classify', tweets, priority, viewer: viewer() }).catch(() => {
        for (const t of tweets) settle(t.id, KEEP);
        applyAll();
      });
    }
  }

  function settle(id, verdict) {
    verdicts.set(id, verdict);
    requested.delete(id);
    attempts.delete(id);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'verdicts') return;
    for (const [id, v] of Object.entries(msg.verdicts)) {
      // Transient failure: stay pending and let the stale sweep below ask again soon
      // (up to MAX_ATTEMPTS, then show the tweet).
      const pending = requested.get(id);
      if (v.retry && pending) {
        pending.at = Date.now() - STALE_MS + RETRY_MS;
        continue;
      }
      settle(id, v);
      countFiltered(id);
    }
    applyAll();
  });

  // ---------- viewer ----------
  // The logged-in X account, from the nav's profile link (present even in the icon-only
  // layout) or the account switcher's text. Switching accounts reloads the page, so the
  // first hit is kept for the life of this script.

  function viewer() {
    if (viewerHandle) return viewerHandle;
    const href = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') ?? '';
    const fromLink = href.match(/^\/(\w{1,15})$/)?.[1];
    const fromSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent.match(/@(\w{1,15})/)?.[1];
    return (viewerHandle = (fromLink ?? fromSwitcher ?? '').toLowerCase());
  }

  // ---------- stats ----------
  // A post is "seen" once any of it has been on screen, and "filtered" if it was seen and
  // its verdict is filter (even if revealed later). Ads count once they reach the page.
  // The background dedupes per day; these sets just avoid resending within this page.

  const seen = new Set(); // tweetIds
  const counted = { filtered: new Set(), ad: new Set() };
  let statEvents = [];
  let statsTimer = null;

  function count(type, id) {
    statEvents.push({ type, id, viewer: viewer() });
    statsTimer ??= setTimeout(() => {
      statsTimer = null;
      const events = statEvents;
      statEvents = [];
      send({ type: 'stats', events }).catch(() => {});
    }, 1000);
  }

  function countSeen(article) {
    const id = article.dataset.icId;
    if (!id || seen.has(id) || verdicts.get(id)?.ad) return;
    seen.add(id);
    count('seen', id);
    countFiltered(id);
  }

  function countFiltered(id) {
    const v = verdicts.get(id);
    if (v?.verdict !== 'filter' || v.ad || !seen.has(id) || counted.filtered.has(id)) return;
    counted.filtered.add(id);
    count('filtered', id);
  }

  function countAd(id) {
    if (counted.ad.has(id)) return;
    counted.ad.add(id);
    count('ad', id);
  }

  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) countSeen(entry.target);
  });

  // Tweets captured by intercept.js (MAIN world) — prefetch verdicts before they scroll into view.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== SOURCE || !Array.isArray(e.data.tweets)) return;
    for (const tweet of e.data.tweets) {
      if (typeof tweet?.id !== 'string' || !/^\d+$/.test(tweet.id)) continue;
      known.set(tweet.id, tweet);
      if (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
      if (tweet.promoted) settle(tweet.id, AD);
      else if (whitelisted(tweet)) settle(tweet.id, WHITELISTED);
      // Only feeds are classified ahead of time; everything else waits until it's on screen.
      else if (e.data.prefetch && settings?.enabled && hasText(tweet)) request(tweet, false);
    }
  });

  // If the background lost a request (e.g. service worker restart), ask again; give up eventually.
  setInterval(() => {
    const now = Date.now();
    for (const [id, r] of requested) {
      if (now - r.at < STALE_MS) continue;
      const n = (attempts.get(id) ?? 0) + 1;
      if (n >= MAX_ATTEMPTS) settle(id, KEEP);
      else {
        attempts.set(id, n);
        requested.delete(id);
      }
    }
    queueScan();
  }, 10_000);

  // ---------- DOM ----------

  function hasText(tweet) {
    return Boolean(tweet.text || tweet.quoted?.text);
  }

  function tweetIdOf(article) {
    // The first timestamp link is the tweet itself; a quoted tweet's timestamp isn't a link.
    for (const time of article.querySelectorAll('time')) {
      const m = time.closest('a[href*="/status/"]')?.getAttribute('href')?.match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    // Ads have no timestamp; use their /status/<id>/analytics link. Links inside the
    // text point at other tweets, so they never count.
    const links = [...article.querySelectorAll('a[href*="/status/"]')].filter((a) => !a.closest('[data-testid="tweetText"]'));
    const link = links.find((a) => /\/analytics$/.test(a.getAttribute('href'))) ?? links[0];
    return link?.getAttribute('href').match(/\/status\/(\d+)/)?.[1] ?? null;
  }

  // Fallback when the tweet wasn't seen in an API response. Media isn't split between
  // the tweet and its quote here; it's all attributed to the tweet.
  function scrape(article, id) {
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')].map((el) => el.innerText.trim());
    const handles = [...article.querySelectorAll('[data-testid="User-Name"]')].map(
      (el) => el.innerText.match(/@(\w+)/)?.[1] ?? '',
    );
    const media = [
      ...[...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map(() => 'photo'),
      ...[...article.querySelectorAll('video')].map(() => 'video'),
    ];
    const tweet = { id, author: handles[0] ?? '', text: texts[0] ?? '', media };
    if (texts[1]) tweet.quoted = { author: handles[1] ?? '', text: texts[1] };
    return tweet;
  }

  // DOM fallback for ads not seen in an API response: no timestamp, and an "Ad" label.
  function looksLikeAd(article) {
    if (article.querySelector('time')) return false;
    return [...article.querySelectorAll('span')].some(
      (s) => s.textContent.trim() === 'Ad' && !s.closest('[data-testid="tweetText"]'),
    );
  }

  function focalId() {
    return location.pathname.match(/\/status\/(\d+)/)?.[1];
  }

  function setData(el, key, value) {
    if (value == null || value === '') {
      if (key in el.dataset) delete el.dataset[key];
    } else if (el.dataset[key] !== value) {
      el.dataset[key] = value;
    }
  }

  function apply(article) {
    const id = article.dataset.icId;
    const v = verdicts.get(id);
    let state = null;
    // Never filter the tweet whose page you deliberately opened.
    if (alive && settings?.enabled && !revealed.has(id) && id !== focalId()) {
      if (!v) state = requested.has(id) ? 'pending' : null;
      else if (v.ad) state = 'ad';
      else if (v.verdict === 'filter') state = 'filtered';
    }
    setData(article, 'ic', state);
    setData(article, 'icMode', state ? settings.mode : null);
    setData(article, 'icLabel', state === 'filtered' ? label(article, id, v) : null);
    // Pending posts always get a spinner; "hold" also blurs them until the verdict arrives.
    setData(article, 'icHold', state === 'pending' && settings.holdPending ? '1' : null);
  }

  // "Filtered", optionally followed by "@handle" and/or the model's reason.
  function label(article, id, v) {
    const parts = ['Filtered'];
    if (settings.showHandle) {
      const handle = handleOf(article, id);
      if (handle) parts.push(`@${handle}`);
    }
    if (settings.showReasons && v?.reason) parts.push(v.reason);
    return parts.join(' · ');
  }

  function handleOf(article, id) {
    // textContent, not innerText: collapsed posts are display:none.
    return (
      known.get(id)?.author ||
      article.querySelector('[data-testid="User-Name"]')?.textContent.match(/@(\w+)/)?.[1] ||
      ''
    );
  }

  function applyAll() {
    for (const article of document.querySelectorAll('article[data-ic-id]')) apply(article);
  }

  function scan() {
    scanQueued = false;
    if (!alive || !settings) return;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const id = tweetIdOf(article);
      if (!id) continue;
      // X recycles nodes, so re-derive the id every scan. Re-observing makes the
      // visibility observer report the new tweet even if the node is already on screen.
      if (article.dataset.icId !== id) {
        setData(article, 'icId', id);
        visibility.unobserve(article);
        visibility.observe(article);
      }
      if (settings.enabled) evaluate(article, id);
      apply(article);
    }
  }

  function evaluate(article, id) {
    if (verdicts.get(id) !== AD && (known.get(id)?.promoted || looksLikeAd(article))) {
      settle(id, AD);
    } else if (!verdicts.has(id)) {
      const tweet = known.get(id) ?? scrape(article, id);
      if (whitelisted(tweet)) settle(id, WHITELISTED);
      else if (hasText(tweet)) request(tweet, true);
      else settle(id, KEEP); // media-only; nothing for a text model to judge
    }
    if (verdicts.get(id)?.ad) countAd(id);
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  const observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Click a filtered or held (blurred pending) tweet to show it (and stop X from opening it).
  document.addEventListener(
    'click',
    (e) => {
      const article = e.target.closest?.("article[data-ic='filtered'], article[data-ic-hold]");
      if (!article) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      revealed.add(article.dataset.icId);
      apply(article);
    },
    true,
  );

  // ---------- settings ----------

  function loadWhitelist() {
    whitelist = new Set((settings.whitelist ?? []).map((h) => String(h).toLowerCase()));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    // The background writes its cache and stats here every second or so; ignore those.
    if (area !== 'local' || !settings || !Object.keys(changes).some((key) => key in settings)) return;
    let invalidate = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (!(key in settings)) continue;
      settings[key] = newValue;
      if (!DISPLAY_KEYS.includes(key)) invalidate = true;
    }
    loadWhitelist();
    if (invalidate) {
      verdicts.clear();
      requested.clear();
      attempts.clear();
      revealed.clear();
    }
    applyAll();
    queueScan();
  });

  send({ type: 'getSettings' })
    .then((s) => {
      settings = s;
      loadWhitelist();
      queueScan();
    })
    .catch(() => {});
})();
