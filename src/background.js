import { PROVIDERS } from './providers/index.js';
import { buildRequest, parseResponse } from './classify.js';
import { DEFAULTS, VERDICT_KEYS, getSettings } from './settings.js';
import { localDay, markInstalled, record, recordUsage } from './stats.js';
import { costOf } from './pricing.js';
import { appendLog } from './log.js';

const CACHE_KEY = 'verdictCache';
const CACHE_LIMIT = 3000;
const OFFSCREEN_URL = 'src/offscreen.html';

// ---------- settings ----------

let settingsPromise = null;
const settings = () => (settingsPromise ??= getSettings());

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Identifies everything that affects a verdict, so cached verdicts from an old
// policy or provider are never reused.
const signature = (s) => hash(JSON.stringify(VERDICT_KEYS.map((k) => s[k])));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((k) => k in DEFAULTS)) return;
  settingsPromise = null;
  if (VERDICT_KEYS.some((k) => k in changes)) {
    queue.length = 0;
    jobs.clear();
    cache = null;
    tabFiltered.clear();
    chrome.action.setBadgeText({ text: '' });
  }
});

// ---------- verdict cache ----------

let cache = null; // Map<tweetId, { verdict, reason }>
let cacheSig = null;
let saveTimer = null;

async function loadCache(sig) {
  if (cache && cacheSig === sig) return cache;
  const { [CACHE_KEY]: stored } = await chrome.storage.local.get(CACHE_KEY);
  cache = new Map(stored?.sig === sig ? stored.entries : []);
  cacheSig = sig;
  return cache;
}

// Throttled (at most one write per second), not debounced, so continuous scrolling
// can't postpone the write indefinitely.
function saveCacheSoon() {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    if (!cache) return;
    chrome.storage.local.set({ [CACHE_KEY]: { sig: cacheSig, entries: [...cache].slice(-CACHE_LIMIT) } });
  }, 1000);
}

// ---------- provider hosting ----------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: OFFSCREEN_URL, reasons: ['WORKERS'], justification: 'Hosts the on-device language model session.' })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function callProvider(provider, method, ...args) {
  if (provider.runsIn !== 'offscreen') return provider[method](...args);
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', provider: provider.id, method, args });
  if (!res?.ok) throw new Error(res?.error ?? 'Offscreen document did not respond');
  return res.result;
}

async function currentProvider() {
  const s = await settings();
  const provider = PROVIDERS[s.provider];
  if (!provider) throw new Error(`Unknown provider "${s.provider}"`);
  return { s, provider, config: s.providerConfig[provider.id] ?? {} };
}

// ---------- classification queue ----------

const queue = []; // jobs waiting for the model, front = next
const jobs = new Map(); // tweetId -> { tweet, sig, viewer, subscribers: Set<"tabId:frameId"> }
let inFlight = 0;
let lastError = null;

// viewer: the X account logged in on the requesting tab (recorded in the log, first requester wins).
async function classify(tweets, subscriber, priority, viewer = '') {
  const sig = signature(await settings());
  const known = await loadCache(sig);
  const hits = {};
  const urgent = [];
  for (const tweet of tweets) {
    if (known.has(tweet.id)) {
      hits[tweet.id] = known.get(tweet.id);
      continue;
    }
    let job = jobs.get(tweet.id);
    if (!job) {
      job = { tweet, sig, viewer, subscribers: new Set() };
      jobs.set(tweet.id, job);
      queue.push(job);
    }
    job.subscribers.add(subscriber);
    if (priority) urgent.push(job);
  }
  // Tweets on screen jump ahead of ones prefetched from the network.
  // (Jobs already in flight aren't in the queue and stay out of it.)
  if (urgent.length) {
    const front = urgent.filter((job) => queue.includes(job));
    const rest = queue.filter((job) => !front.includes(job));
    queue.splice(0, queue.length, ...front, ...rest);
  }
  if (Object.keys(hits).length) deliver(subscriber, hits);
  pump();
}

// Starts batches until the provider's concurrency limit is reached; each finished
// batch calls pump() again to pick up whatever is queued next.
async function pump() {
  if (!queue.length) return;
  let ctx;
  try {
    ctx = await currentProvider();
  } catch (err) {
    fail(queue.splice(0), err);
    return;
  }
  while (inFlight < (ctx.provider.concurrency ?? 1) && queue.length) {
    inFlight++;
    runBatch(ctx, queue.splice(0, ctx.provider.batchSize)).finally(() => {
      inFlight--;
      pump();
    });
  }
}

async function runBatch({ s, provider, config }, batch) {
  const tweets = batch.map((job) => job.tweet);
  let verdicts, model, usage;
  try {
    const res = await callProvider(provider, 'generate', buildRequest(tweets, s.policy), config);
    ({ model, usage } = res);
    verdicts = parseResponse(res.result, tweets);
    lastError = null;
  } catch (err) {
    fail(batch, err);
    return;
  }
  const cost = costOf(provider.id, model, usage);
  recordUsage(usage, cost, batch[0].viewer); // a batch is almost always one account's posts
  logBatch({ provider: provider.id, model, policy: s.policy, batch, verdicts, usage, cost });

  const sig = signature(await settings());
  const bySubscriber = new Map();
  batch.forEach((job, i) => {
    if (jobs.get(job.tweet.id) === job) jobs.delete(job.tweet.id);
    if (job.sig !== sig) return; // policy changed while this batch was running
    const { verdict, reason } = verdicts[i];
    cache?.set(job.tweet.id, { verdict, reason });
    for (const sub of job.subscribers) {
      if (!bySubscriber.has(sub)) bySubscriber.set(sub, {});
      bySubscriber.get(sub)[job.tweet.id] = { verdict, reason };
    }
  });
  for (const [sub, v] of bySubscriber) deliver(sub, v);
  saveCacheSoon();
}

// One log row per post, sharing a batch id. Logged even if the policy changed mid-flight:
// the analysis happened, and the row records which policy it ran under.
function logBatch({ provider, model, policy, batch, verdicts, usage, cost }) {
  const at = Date.now();
  const batchId = `${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const rows = batch.map(({ tweet, viewer }, i) => ({
    at,
    day: localDay(new Date(at)),
    batch: batchId,
    provider,
    model,
    policy: hash(policy),
    viewer,
    id: tweet.id,
    author: tweet.author ?? '',
    text: tweet.text ?? '',
    quoted: tweet.quoted ?? null,
    media: tweet.media ?? [],
    verdict: verdicts[i].verdict,
    reason: verdicts[i].reason,
    batchSize: batch.length,
    usage,
    cost,
  }));
  appendLog(rows).catch((err) => console.warn('[prism] log write failed:', err?.message ?? err));
}

// Rate limits, overload, timeouts and network hiccups are worth retrying; bad keys,
// invalid requests and unavailable models are not.
function isTransient(err) {
  const message = err?.message ?? '';
  return (
    ['TimeoutError', 'AbortError'].includes(err?.name) ||
    err instanceof TypeError || // fetch network failure
    /\b(408|409|429|5\d\d)\b|timed out|Failed to fetch|Receiving end does not exist|did not respond/i.test(message)
  );
}

// Fail open: tweets we couldn't classify are shown (transient errors are retried by the
// content script first), and the error surfaces on the badge.
function fail(batch, err) {
  lastError = err?.message ?? String(err);
  console.warn('[prism] classification failed:', lastError);
  const retry = isTransient(err);
  const bySubscriber = new Map();
  for (const job of batch) {
    if (jobs.get(job.tweet.id) === job) jobs.delete(job.tweet.id);
    for (const sub of job.subscribers) {
      if (!bySubscriber.has(sub)) bySubscriber.set(sub, {});
      bySubscriber.get(sub)[job.tweet.id] = { verdict: 'keep', reason: '', error: true, retry };
    }
  }
  for (const [sub, v] of bySubscriber) deliver(sub, v);
}

// ---------- delivery + badge ----------

const tabFiltered = new Map(); // tabId -> Set<tweetId>

function deliver(subscriber, verdicts) {
  const [tabId, frameId] = subscriber.split(':').map(Number);
  chrome.tabs.sendMessage(tabId, { type: 'verdicts', verdicts }, { frameId }).catch(() => {});

  if (!tabFiltered.has(tabId)) tabFiltered.set(tabId, new Set());
  const filtered = tabFiltered.get(tabId);
  let errored = false;
  for (const [id, v] of Object.entries(verdicts)) {
    if (v.verdict === 'filter') filtered.add(id);
    if (v.error) errored = true;
  }
  const text = errored ? '!' : filtered.size ? String(filtered.size) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: errored ? '#d93025' : '#536471' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: errored ? `Prism: ${lastError}` : `Prism: ${filtered.size} filtered` }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') tabFiltered.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => tabFiltered.delete(tabId));

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'getSettings':
      settings().then(sendResponse);
      return true;

    case 'classify':
      // Verdicts are pushed back to the tab as each batch finishes; this is just an ack.
      if (sender.tab) classify(msg.tweets, `${sender.tab.id}:${sender.frameId}`, msg.priority, msg.viewer);
      sendResponse({ ok: true });
      return false;

    case 'stats':
      record(msg.events);
      sendResponse({ ok: true });
      return false;

    case 'status':
      currentProvider()
        .then(async ({ provider, config }) => ({
          provider: provider.id,
          ...(await callProvider(provider, 'status', config)),
          lastError,
          queued: queue.length,
        }))
        .catch((err) => ({ state: 'unavailable', detail: err?.message ?? String(err) }))
        .then(sendResponse);
      return true;

    case 'test': {
      const tweet = { id: 'test', author: msg.author || 'someone', text: msg.text };
      const started = performance.now();
      currentProvider()
        .then(async ({ s, provider, config }) => {
          const policy = msg.policy ?? s.policy;
          const { result, model, usage } = await callProvider(provider, 'generate', buildRequest([tweet], policy), config);
          const cost = costOf(provider.id, model, usage);
          recordUsage(usage, cost); // a real request, so it counts toward spend (but isn't logged)
          return { ...parseResponse(result, [tweet])[0], ms: Math.round(performance.now() - started), raw: result, model, cost };
        })
        .catch((err) => ({ error: err?.message ?? String(err) }))
        .then(sendResponse);
      return true;
    }
  }
  return false;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => markInstalled());
