// Daily counts of posts seen / filtered / ads removed, kept in chrome.storage.local.
// Everything stays on this machine.
//
// stats = { installedAt: 'YYYY-MM-DD', days: { 'YYYY-MM-DD': { seen, filtered, ads, viewers, usage } } }
// Day-level counts are totals across every logged-in X account; viewers splits them by
// account: { handle: { seen, filtered, ads, usage } }. Events with no detectable account
// only count toward the totals.
// usage = { requests, input, cached, output, cost, unpriced } — tokens and USD spent on the model
// that day; `unpriced` counts requests whose model has no known price (excluded from cost).
// statsToday = "viewer|tweetId" keys already counted today, so a post is counted once per day
// per account across tabs and reloads.

export const STATS_KEY = 'stats';
const TODAY_KEY = 'statsToday';
const SAVE_MS = 1000;

// YYYY-MM-DD in local time.
export const localDay = (date = new Date()) => date.toLocaleDateString('en-CA');

let loaded = null;
let saveTimer = null;

function load() {
  return (loaded ??= chrome.storage.local.get([STATS_KEY, TODAY_KEY]).then((stored) => {
    const stats = stored[STATS_KEY] ?? { installedAt: localDay(), days: {} };
    for (const day of Object.values(stats.days)) delete day.accounts; // pre-viewer per-author breakdown
    const t = stored[TODAY_KEY];
    const today = { day: t?.day, seen: new Set(t?.seen), filtered: new Set(t?.filtered), ad: new Set(t?.ad) };
    return { stats, today };
  }));
}

// Throttled rather than debounced, so steady scrolling can't postpone the write forever.
function saveSoon() {
  saveTimer ??= setTimeout(async () => {
    saveTimer = null;
    const { stats, today } = await load();
    chrome.storage.local.set({
      [STATS_KEY]: stats,
      [TODAY_KEY]: { day: today.day, seen: [...today.seen], filtered: [...today.filtered], ad: [...today.ad] },
    });
  }, SAVE_MS);
}

export async function markInstalled() {
  const { stats } = await load();
  stats.installedAt ??= localDay();
  saveSoon();
}

// events: [{ type: 'seen' | 'filtered' | 'ad', id, viewer }] — viewer is the logged-in handle, or ''.
export async function record(events) {
  const { stats, today } = await load();
  const day = localDay();
  if (today.day !== day) {
    today.day = day;
    for (const type of ['seen', 'filtered', 'ad']) today[type].clear();
  }
  const counts = (stats.days[day] ??= { seen: 0, filtered: 0, ads: 0 });
  for (const { type, id, viewer = '' } of events) {
    const done = today[type];
    const key = `${viewer}|${id}`;
    if (!done || done.has(key)) continue;
    if (type === 'filtered' && !today.seen.has(key)) continue; // only count posts seen today
    done.add(key);
    const field = type === 'ad' ? 'ads' : type;
    counts[field]++;
    if (viewer) ((counts.viewers ??= {})[viewer] ??= { seen: 0, filtered: 0, ads: 0 })[field]++;
  }
  saveSoon();
}

// One model request: token usage ({ input, cached, cacheWrite, output } or null), its
// cost in USD (null when the model's price is unknown), and the account whose tab asked.
export async function recordUsage(usage, cost, viewer = '') {
  const { stats } = await load();
  const day = localDay();
  const counts = (stats.days[day] ??= { seen: 0, filtered: 0, ads: 0 });
  const buckets = [counts];
  if (viewer) buckets.push((counts.viewers ??= {})[viewer] ??= { seen: 0, filtered: 0, ads: 0 });
  for (const bucket of buckets) {
    const u = (bucket.usage ??= { requests: 0, input: 0, cached: 0, output: 0, cost: 0, unpriced: 0 });
    u.requests++;
    u.input += (usage?.input ?? 0) + (usage?.cacheWrite ?? 0);
    u.cached += usage?.cached ?? 0;
    u.output += usage?.output ?? 0;
    if (cost === null) u.unpriced++;
    else u.cost += cost;
  }
  saveSoon();
}
