// Daily counts of posts seen / filtered / ads removed, kept in chrome.storage.local.
// Everything stays on this machine.
//
// stats = { installedAt: 'YYYY-MM-DD', days: { 'YYYY-MM-DD': { seen, filtered, ads, accounts: { handle: [seen, filtered] } } } }
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
