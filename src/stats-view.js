// Stats section of the options page: totals, a daily stacked-column chart
// (shown + filtered = seen) and a per-account breakdown, all for one selected period.
import { STATS_KEY, localDay } from './stats.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOP_ACCOUNTS = 25;
const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString();
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');
// Cheap models spend fractions of a cent per day, so show four decimals under a dollar.
const fmtCost = (usd) => (usd === 0 ? '$0' : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);
const NO_USAGE = { requests: 0, input: 0, cached: 0, output: 0, cost: 0, unpriced: 0 };
const tokensOf = (u) => u.input + u.cached + u.output;

let stats = { installedAt: localDay(), days: {} };
let period = 'all';
let view = 'day';
let accountSort = 'seen';
let showAllAccounts = false;

// ---------- data ----------

function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// One entry per calendar day in the selected period, zero-filled.
function daysInPeriod() {
  const today = parseDay(localDay());
  let start = parseDay(stats.installedAt ?? localDay());
  if (period !== 'all') {
    const from = new Date(today);
    from.setDate(from.getDate() - (Number(period) - 1));
    if (from > start) start = from;
  }
  const days = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const c = stats.days[localDay(d)];
    days.push({
      date: new Date(d),
      seen: c?.seen ?? 0,
      filtered: c?.filtered ?? 0,
      ads: c?.ads ?? 0,
      accounts: c?.accounts ?? {},
      usage: { ...NO_USAGE, ...c?.usage },
    });
  }
  return days;
}

const sum = (days, key) => days.reduce((n, d) => n + d[key], 0);
const sumUsage = (days, key) => days.reduce((n, d) => n + d.usage[key], 0);

// ---------- DOM helpers ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function keyed(tag, color, ...children) {
  const node = el(tag, {}, ...children);
  node.style.setProperty('--key', color);
  return node;
}

function legend() {
  return el(
    'div',
    { className: 'legend' },
    keyed('span', 'var(--series-shown)', 'Shown'),
    keyed('span', 'var(--series-filtered)', 'Filtered'),
  );
}

// ---------- tiles ----------

function renderTiles(days) {
  const seen = sum(days, 'seen');
  const filtered = sum(days, 'filtered');
  const tile = (label, value, note) =>
    el('div', { className: 'tile' }, el('div', { className: 'label', textContent: label }), el('div', { className: 'value', textContent: value }), note ? el('div', { className: 'note', textContent: note }) : null);

  // Spend for the period, with today's figure always visible in the note.
  const today = stats.days[localDay()]?.usage ?? NO_USAGE;
  const unpriced = sumUsage(days, 'unpriced');
  const spendNote = [`${fmtCost(today.cost ?? 0)} today`, unpriced ? `${fmt(unpriced)} request${unpriced === 1 ? '' : 's'} at unknown price` : null].filter(Boolean).join(' · ');

  $('stats-tiles').replaceChildren(
    tile('Posts seen', fmt(seen)),
    tile('Filtered', fmt(filtered), `${pct(filtered, seen)} of seen`),
    tile('Ads removed', fmt(sum(days, 'ads'))),
    tile('Spent', fmtCost(sumUsage(days, 'cost')), spendNote),
  );
}

// ---------- daily chart ----------

// Round axis maximum and step: 1, 2 or 5 × 10^k.
function niceScale(max, ticks = 4) {
  const raw = Math.max(1, max) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { step, top: Math.ceil(Math.max(1, max) / step) * step };
}

// Rect with 4px-rounded top corners, square at the baseline.
function topRounded(x, y, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const shortDate = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function renderDaily(days, container) {
  const width = Math.max(280, container.clientWidth);
  const height = 220;
  const m = { top: 10, right: 4, bottom: 24, left: 40 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const base = m.top + plotH;
  const { step, top } = niceScale(Math.max(...days.map((d) => d.seen)));
  const y = (v) => base - (v / top) * plotH;

  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'group', 'aria-label': 'Posts seen per day, split into shown and filtered' });

  for (let v = 0; v <= top; v += step) {
    chart.append(svg('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), stroke: v ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const tick = svg('text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' });
    tick.textContent = fmt(v);
    chart.append(tick);
  }

  const band = plotW / days.length;
  const barW = Math.max(1, Math.min(24, band * 0.7));
  const labelEvery = Math.ceil(days.length / 6);
  const wrap = el('div', { className: 'chart' });
  const tooltip = el('div', { className: 'tooltip', hidden: true });

  days.forEach((d, i) => {
    const col = svg('g', { class: 'col', tabindex: 0, role: 'img', 'aria-label': `${longDate(d.date)}: ${d.seen} seen, ${d.filtered} filtered` });
    col.append(svg('rect', { class: 'hit', x: m.left + i * band, y: m.top, width: band, height: plotH, fill: 'transparent' }));

    // Stacked from the baseline: shown, 2px surface gap, filtered on top.
    const x = m.left + i * band + (band - barW) / 2;
    const shown = d.seen - d.filtered;
    const hShown = shown ? Math.max(1, (shown / top) * plotH) : 0;
    const hFiltered = d.filtered ? Math.max(1, (d.filtered / top) * plotH) : 0;
    const gap = hShown && hFiltered ? 2 : 0;
    if (hShown) {
      const h = hShown - gap / 2;
      col.append(hFiltered
        ? svg('rect', { class: 'bar', x, y: base - h, width: barW, height: h, fill: 'var(--series-shown)' })
        : svg('path', { class: 'bar', d: topRounded(x, base - h, barW, h), fill: 'var(--series-shown)' }));
    }
    if (hFiltered) {
      const h = hFiltered - gap / 2;
      col.append(svg('path', { class: 'bar', d: topRounded(x, base - hShown - gap / 2 - h, barW, h), fill: 'var(--series-filtered)' }));
    }

    if ((days.length - 1 - i) % labelEvery === 0) {
      // Centered under the column, but right-aligned when that would run off the edge.
      const cx = m.left + i * band + band / 2;
      const nearEdge = cx > width - 24;
      const label = svg('text', { x: nearEdge ? width - m.right : cx, y: height - 6, 'text-anchor': nearEdge ? 'end' : 'middle', class: 'tick' });
      label.textContent = shortDate(d.date);
      chart.append(label);
    }

    const show = () => {
      tooltip.replaceChildren(
        el('div', { className: 'date', textContent: longDate(d.date) }),
        keyed('div', 'var(--series-filtered)', el('b', { textContent: fmt(d.filtered) }), ` filtered (${pct(d.filtered, d.seen)})`),
        keyed('div', 'var(--series-shown)', el('b', { textContent: fmt(shown) }), ' shown'),
        el('div', { className: 'date', textContent: `${fmt(d.seen)} seen${d.ads ? ` · ${fmt(d.ads)} ads removed` : ''}` }),
        d.usage.requests
          ? el('div', { className: 'date', textContent: `${fmtCost(d.usage.cost)} · ${fmt(tokensOf(d.usage))} tokens · ${fmt(d.usage.requests)} requests` })
          : null,
      );
      for (const line of [...tooltip.children].slice(1, 3)) line.className = 'line';
      tooltip.hidden = false;
      const cx = m.left + i * band + band / 2;
      const left = Math.min(Math.max(0, cx - tooltip.offsetWidth / 2), width - tooltip.offsetWidth);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(0, y(d.seen) - tooltip.offsetHeight - 10)}px`;
    };
    const hide = () => (tooltip.hidden = true);
    col.addEventListener('pointerenter', show);
    col.addEventListener('focus', show);
    col.addEventListener('pointerleave', hide);
    col.addEventListener('blur', hide);
    chart.append(col);
  });

  wrap.append(chart, tooltip);

  const table = el(
    'table',
    { className: 'days' },
    el('thead', {}, el('tr', {}, ...['Date', 'Seen', 'Filtered', '% filtered', 'Ads removed', 'Tokens', 'Cost'].map((t) => el('th', { textContent: t })))),
    el('tbody', {}, ...[...days].reverse().map((d) =>
      el('tr', {}, ...[longDate(d.date), fmt(d.seen), fmt(d.filtered), pct(d.filtered, d.seen), fmt(d.ads), fmt(tokensOf(d.usage)), fmtCost(d.usage.cost)].map((t) => el('td', { textContent: t }))),
    )),
  );
  const details = el('details', {}, el('summary', { className: 'hint', textContent: 'Show as table' }), table);

  container.replaceChildren(legend(), wrap, details);
}

// ---------- by account ----------

function renderAccounts(days, container) {
  const totals = new Map();
  for (const d of days) {
    for (const [handle, [seen, filtered]] of Object.entries(d.accounts)) {
      const t = totals.get(handle) ?? [0, 0];
      t[0] += seen;
      t[1] += filtered;
      totals.set(handle, t);
    }
  }
  const idx = accountSort === 'seen' ? 0 : 1;
  const rows = [...totals].sort((a, b) => b[1][idx] - a[1][idx] || b[1][1 - idx] - a[1][1 - idx]);
  const shownRows = showAllAccounts ? rows : rows.slice(0, TOP_ACCOUNTS);
  const max = Math.max(1, ...rows.map(([, [seen]]) => seen));

  const sort = el('div', { className: 'seg', role: 'group', ariaLabel: 'Sort accounts' });
  for (const [key, text] of [['seen', 'Most seen'], ['filtered', 'Most filtered']]) {
    const b = el('button', { textContent: text });
    b.setAttribute('aria-pressed', String(accountSort === key));
    b.addEventListener('click', () => {
      accountSort = key;
      render();
    });
    sort.append(b);
  }

  const list = el('div', { className: 'accounts' });
  for (const [handle, [seen, filtered]] of shownRows) {
    const bar = el('div', { className: 'hbar' });
    for (const [n, color] of [[seen - filtered, 'var(--series-shown)'], [filtered, 'var(--series-filtered)']]) {
      if (!n) continue;
      const seg = el('i');
      seg.style.width = `${(n / max) * 100}%`;
      seg.style.background = color;
      bar.append(seg);
    }
    list.append(
      el('a', { href: `https://x.com/${encodeURIComponent(handle)}`, target: '_blank', rel: 'noreferrer', textContent: `@${handle}` }),
      bar,
      el('span', { className: 'nums', textContent: `${fmt(seen)} seen · ${fmt(filtered)} filtered` }),
    );
  }

  const more = rows.length > TOP_ACCOUNTS
    ? el('button', { className: 'secondary', textContent: showAllAccounts ? 'Show top 25' : `Show all ${fmt(rows.length)} accounts` })
    : null;
  more?.addEventListener('click', () => {
    showAllAccounts = !showAllAccounts;
    render();
  });

  container.replaceChildren(
    el('div', { className: 'controls' }, sort, el('span', { className: 'hint', textContent: `${fmt(rows.length)} accounts` })),
    legend(),
    list,
    ...(more ? [el('div', { className: 'row' }, more)] : []),
  );
}

// ---------- wiring ----------

function render() {
  const days = daysInPeriod();
  for (const b of $('stats-period').children) b.setAttribute('aria-pressed', String(b.dataset.period === period));
  for (const b of $('stats-view').children) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  renderTiles(days);
  const body = $('stats-body');
  if (!sum(days, 'seen') && !sum(days, 'ads')) {
    body.replaceChildren(el('div', { className: 'empty', textContent: 'Nothing counted yet for this period. Scroll your X feed and check back.' }));
  } else if (view === 'day') {
    renderDaily(days, body);
  } else {
    renderAccounts(days, body);
  }
}

export async function initStats() {
  stats = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY] ?? stats;
  $('stats-period').addEventListener('click', (e) => {
    if (!e.target.dataset.period) return;
    period = e.target.dataset.period;
    render();
  });
  $('stats-view').addEventListener('click', (e) => {
    if (!e.target.dataset.view) return;
    view = e.target.dataset.view;
    render();
  });
  // Live: counts update while you scroll X in another tab.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATS_KEY]?.newValue) {
      stats = changes[STATS_KEY].newValue;
      render();
    }
  });
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w !== lastWidth && view === 'day') {
      lastWidth = w;
      render();
    }
  }).observe($('stats-body'));
  render();
}
