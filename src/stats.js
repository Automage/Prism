// Daily counts of posts seen / filtered / ads removed, kept in chrome.storage.local.
// Everything stays on this machine.
//
// stats = { installedAt: 'YYYY-MM-DD', days: { 'YYYY-MM-DD': { seen, filtered, ads, accounts: { handle: [seen, filtered] }, usage } } }
// usage = { requests, input, cached, output, cost, unpriced } — tokens and USD spent on the model
// that day; `unpriced` counts requests whose model has no known price (excluded from cost).
// statsToday = ids already counted today, so a post is counted once per day across tabs and reloads.

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

// events: [{ type: 'seen' | 'filtered' | 'ad', id, author }]
export async function record(events) {
  const { stats, today } = await load();
  const day = localDay();
  if (today.day !== day) {
    today.day = day;
    for (const type of ['seen', 'filtered', 'ad']) today[type].clear();
  }
  const counts = (stats.days[day] ??= { seen: 0, filtered: 0, ads: 0, accounts: {} });
  for (const { type, id, author } of events) {
    const done = today[type];
    if (!done || done.has(id)) continue;
    if (type === 'filtered' && !today.seen.has(id)) continue; // only count posts seen today
    done.add(id);
    if (type === 'ad') {
      counts.ads++;
      continue;
    }
    counts[type]++;
    if (author) (counts.accounts[author] ??= [0, 0])[type === 'seen' ? 0 : 1]++;
  }
  saveSoon();
}

// One model request: token usage ({ input, cached, cacheWrite, output } or null) and its
// cost in USD (null when the model's price is unknown).
export async function recordUsage(usage, cost) {
  const { stats } = await load();
  const day = localDay();
  const counts = (stats.days[day] ??= { seen: 0, filtered: 0, ads: 0, accounts: {} });
  const u = (counts.usage ??= { requests: 0, input: 0, cached: 0, output: 0, cost: 0, unpriced: 0 });
  u.requests++;
  u.input += (usage?.input ?? 0) + (usage?.cacheWrite ?? 0);
  u.cached += usage?.cached ?? 0;
  u.output += usage?.output ?? 0;
  if (cost === null) u.unpriced++;
  else u.cost += cost;
  saveSoon();
}
