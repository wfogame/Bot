'use strict'

/**
 * The data-scientist view: one JSON report and one self-contained HTML page.
 *
 * No chart library and no CDN — the SVG is generated here, so the page works
 * offline, in a container, and from a phone on the same network, and nothing
 * about the bot's data leaves the machine.
 */

function esc (value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmt (value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '–'
  const n = Number(value)
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'k'
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 2) })
}

function pct (value, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? '–' : `${(Number(value) * 100).toFixed(digits)}%`
}

function fmtTime (t) {
  if (!t) return '–'
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + 'Z'
}

function duration (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '–'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${mins}m`
  return `${mins}m`
}

/** The machine-readable report behind /api/analytics. */
function buildReport ({ coinflip = null, timeseries = null, deep = null, config = {}, generatedAt = Date.now() } = {}) {
  return {
    generatedAt,
    generatedAtIso: fmtTime(generatedAt),
    config,
    coinflip,
    timeseries,
    deep,
    headline: buildHeadline(coinflip, timeseries)
  }
}

function buildHeadline (coinflip, timeseries) {
  const stats = coinflip && coinflip.stats
  const fair = coinflip && coinflip.fairness
  const summary = (timeseries && timeseries.summary) || {}
  const fleetBots = timeseries && timeseries.bots ? timeseries.bots.length : 0
  return {
    coinflips: stats ? stats.resolved : 0,
    coinflipNet: stats ? stats.net : 0,
    coinflipWinRate: stats ? stats.winRate : null,
    coinflipVerdict: fair ? fair.verdict : 'insufficient-data',
    coinflipP: fair ? fair.p : null,
    trackedBots: fleetBots,
    samples: timeseries ? timeseries.totalSamples : 0,
    shardsNow: summary.shards ? summary.shards.last : null,
    balanceNow: summary.balance ? summary.balance.last : null,
    window: summary.shards ? { from: summary.shards.from, to: summary.shards.to } : null
  }
}

// ── SVG charts ───────────────────────────────────────────────────────────────

/**
 * A single-series line chart. Points are {t, last} buckets in time order; the
 * x-axis is time, not index, so a gap in sampling shows as a gap rather than
 * being drawn as if it were continuous.
 */
function lineChart (buckets, opts = {}) {
  const width = opts.width || 640
  const height = opts.height || 140
  const pad = { top: 14, right: 54, bottom: 18, left: 8 }
  const label = opts.label || ''
  const points = (buckets || []).filter(b => typeof b.last === 'number')
  if (points.length < 2) {
    return `<div class="empty">${esc(label)}: not enough samples yet</div>`
  }
  const values = points.map(p => p.last)
  const times = points.map(p => p.t)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const t0 = Math.min(...times)
  const t1 = Math.max(...times)
  const tSpan = t1 - t0 || 1
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const x = t => pad.left + ((t - t0) / tSpan) * innerW
  const y = v => pad.top + innerH - ((v - min) / span) * innerH

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.last).toFixed(1)}`).join(' ')
  const area = `${line} L${x(t1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(t0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`
  const grid = [0, 0.5, 1].map(f => {
    const gy = pad.top + innerH * f
    const value = max - span * f
    return `<line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${pad.left + innerW}" y2="${gy.toFixed(1)}" class="grid"/>
<text x="${pad.left + innerW + 6}" y="${(gy + 3.5).toFixed(1)}" class="axis">${esc(fmt(value))}</text>`
  }).join('')
  const color = opts.color || 'var(--acc)'

  return `<figure class="chart">
<figcaption>${esc(label)} <span class="range">${esc(fmt(min))} → ${esc(fmt(max))} · ${points.length} buckets · ${esc(duration(tSpan))}</span></figcaption>
<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} trend">
${grid}
<path d="${area}" fill="${color}" opacity="0.12"/>
<path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
<circle cx="${x(points[points.length - 1].t).toFixed(1)}" cy="${y(points[points.length - 1].last).toFixed(1)}" r="3" fill="${color}"/>
<text x="${pad.left}" y="${height - 5}" class="axis">${esc(fmtTime(t0))}</text>
<text x="${pad.left + innerW - 90}" y="${height - 5}" class="axis">${esc(fmtTime(t1))}</text>
</svg></figure>`
}

/** A horizontal bar for a rate, with the 50% line marked for coinflips. */
function rateBar (value, { mid = null, low = null, high = null } = {}) {
  if (value == null) return '<div class="empty">no resolved flips yet</div>'
  const width = 260
  const pos = Math.max(0, Math.min(1, value)) * width
  const ci = low != null && high != null
    ? `<span class="ci" style="left:${(Math.max(0, Math.min(1, low)) * width).toFixed(0)}px;width:${((Math.min(1, high) - Math.max(0, low)) * width).toFixed(0)}px"></span>`
    : ''
  const midMark = mid == null ? '' : `<i class="mid" style="left:${(mid * width).toFixed(0)}px"></i>`
  return `<div class="ratebar"><b style="width:${pos.toFixed(0)}px"></b>${ci}${midMark}</div>`
}

function verdictClass (verdict) {
  if (verdict === 'suspicious') return 'bad'
  if (verdict === 'watch') return 'warn'
  if (verdict === 'within-noise') return 'good'
  return 'dim'
}

// ── HTML report ──────────────────────────────────────────────────────────────

const STYLE = `
:root{--bg:#0a0e13;--panel:#0f151d;--panel2:#131b25;--line:#1d2836;--txt:#c7d2dc;--dim:#5b6b7a;--acc:#2dd4bf;--red:#f87171;--grn:#4ade80;--yel:#fbbf24;--cyan:#67e8f9;--mag:#e879f9}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--txt);font:13px/1.5 ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace;margin:0;padding:22px 18px 60px}
h1{font-size:17px;margin:0 0 4px;color:#e8f0f6;letter-spacing:.4px}
h1 b{color:var(--acc)}
h2{font-size:13px;margin:26px 0 10px;color:var(--acc);text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid var(--line);padding-bottom:6px}
a{color:var(--cyan)}
.sub{color:var(--dim);font-size:12px;margin:0 0 16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.kpi span{display:block;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.kpi b{font-size:19px;color:#e8f0f6;font-weight:600}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
.verdict{border-left:3px solid var(--acc);padding:10px 12px;background:var(--panel2);border-radius:6px;margin-bottom:12px}
.verdict.good{border-color:var(--grn)}.verdict.warn{border-color:var(--yel)}.verdict.bad{border-color:var(--red)}.verdict.dim{border-color:var(--dim)}
.verdict b{color:#e8f0f6}
.verdict ul{margin:8px 0 0;padding-left:18px;color:var(--dim)}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:500;text-transform:uppercase;font-size:10px;letter-spacing:.6px}
td.num{text-align:right}
tr:hover td{background:var(--panel2)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.chart{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px}
.chart figcaption{color:#dbe6ee;font-size:12px;margin-bottom:6px}
.chart .range{color:var(--dim);font-size:11px;float:right}
.chart svg{width:100%;height:120px;display:block}
.grid{stroke:var(--line);stroke-width:1;stroke-dasharray:3 4}
.axis{fill:var(--dim);font-size:9px}
.empty{color:var(--dim);font-size:12px;padding:8px 0}
.ratebar{position:relative;width:260px;height:16px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;overflow:hidden;margin-top:6px}
.ratebar b{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,rgba(45,212,191,.35),var(--acc))}
.ratebar .ci{position:absolute;top:0;bottom:0;border-left:1px solid #e8f0f6;border-right:1px solid #e8f0f6;opacity:.55}
.ratebar .mid{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--red);opacity:.8}
.pill{display:inline-block;border-radius:20px;padding:1px 9px;font-size:11px;border:1px solid var(--line)}
.pill.good{color:var(--grn);border-color:rgba(74,222,128,.45)}
.pill.warn{color:var(--yel);border-color:rgba(251,191,36,.45)}
.pill.bad{color:var(--red);border-color:rgba(248,113,113,.45)}
.pill.dim{color:var(--dim)}
.win{color:var(--grn)}.loss{color:var(--red)}
code{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:11px}
tr.sig td{background:rgba(74,222,128,.07)}
ul.takeaways{margin:0;padding-left:18px;color:var(--txt)}
ul.takeaways li{margin:0 0 4px}
.eq{color:var(--dim)}
`

function kpi (label, value, cls = '') {
  return `<div class="kpi"><span>${esc(label)}</span><b class="${cls}">${esc(value)}</b></div>`
}

function coinflipSection (coinflip) {
  if (!coinflip || !coinflip.stats || !coinflip.stats.resolved) {
    return `<div class="panel"><h2>Coinflip</h2><div class="empty">No resolved coinflips recorded yet. Run <code>/bot-coinflip run</code> and the history fills in here.</div></div>`
  }
  const s = coinflip.stats
  const f = coinflip.fairness || {}
  const netClass = s.net >= 0 ? 'win' : 'loss'
  const oppRows = (s.opponents || []).slice(0, 15).map(o => `<tr><td>${esc(o.opponent)}</td><td class="num">${o.flips}</td><td class="num ${o.wins >= o.losses ? 'win' : 'loss'}">${o.wins}W/${o.losses}L</td><td class="num">${pct(o.flips ? o.wins / o.flips : null)}</td><td class="num ${o.net >= 0 ? 'win' : 'loss'}">${esc(fmt(o.net))}</td></tr>`).join('')
  const botRows = (s.bots || []).map(b => `<tr><td>${esc(b.bot)}</td><td class="num">${b.flips}</td><td class="num">${b.wins}W/${b.losses}L</td><td class="num">${pct(b.flips ? b.wins / b.flips : null)}</td><td class="num ${b.net >= 0 ? 'win' : 'loss'}">${esc(fmt(b.net))}</td><td class="num">${esc(fmt(b.wagered))}</td></tr>`).join('')
  const flips = (coinflip.recent || []).map(r => `<tr><td>${esc(fmtTime(r.ts))}</td><td>${esc(r.bot)}</td><td class="${r.result === 'won' ? 'win' : r.result === 'lost' ? 'loss' : 'dim'}">${esc(r.result)}</td><td class="num">${esc(fmt(r.wager))}</td><td>${esc(r.opponent || '–')}</td><td class="num ${(r.delta || 0) >= 0 ? 'win' : 'loss'}">${esc(fmt(r.delta))}</td><td>${esc(r.method)}${r.mismatched ? ' ⚠' : ''}</td></tr>`).join('')

  return `<h2>Coinflip</h2>
<div class="kpis">
${kpi('resolved flips', s.resolved)}
${kpi('net', fmt(s.net), netClass)}
${kpi('win rate', pct(s.winRate))}
${kpi('wagered', fmt(s.wagered))}
${kpi('current streak', `${s.currentStreak.length} ${s.currentStreak.kind || ''}`.trim())}
${kpi('longest win / loss streak', `${s.longestWinStreak} / ${s.longestLossStreak}`)}
${kpi('max drawdown', fmt(s.maxDrawdown), 'loss')}
${kpi('message/balance mismatches', s.mismatches, s.mismatches ? 'loss' : '')}
</div>
<div class="panel" style="margin-top:12px">
<div class="verdict ${verdictClass(f.verdict)}">
<b>Fairness verdict: ${esc(f.verdict || 'insufficient-data')}</b>
<div class="sub" style="margin:6px 0 0">${s.wins}W / ${s.losses}L over ${f.n || s.resolved} resolved flip(s)${f.p == null ? '' : ` · two-sided p = ${esc(f.p.toExponential(2))}`}${f.ci ? ` · 95% CI ${esc(pct(f.ci.low))}–${esc(pct(f.ci.high))}` : ''}</div>
<div class="ratebar"><b style="width:${((s.winRate || 0) * 260).toFixed(0)}px"></b>${f.ci ? `<span class="ci" style="left:${(f.ci.low * 260).toFixed(0)}px;width:${((f.ci.high - f.ci.low) * 260).toFixed(0)}px"></span>` : ''}<i class="mid" style="left:130px"></i></div>
<div class="sub" style="margin-top:6px">The bar is the observed win rate; the red line is the 50% a fair coin would give; the white markers are the 95% confidence interval.${f.runs && f.runs.p != null ? ` Runs test: ${f.runs.runs} runs vs ${f.runs.expected.toFixed(1)} expected (p = ${f.runs.p.toFixed(4)}).` : ''}</div>
${(f.flags || []).length ? `<ul>${f.flags.map(flag => `<li>${esc(flag)}</li>`).join('')}</ul>` : ''}
</div>
<table><thead><tr><th>bot</th><th>flips</th><th>W/L</th><th>rate</th><th>net</th><th>wagered</th></tr></thead><tbody>${botRows || '<tr><td colspan="6" class="empty">no data</td></tr>'}</tbody></table>
</div>
<div class="panel">
<h2 style="margin-top:0">Opponents</h2>
<table><thead><tr><th>opponent</th><th>flips</th><th>W/L</th><th>rate</th><th>net</th></tr></thead><tbody>${oppRows || '<tr><td colspan="5" class="empty">no named opponents recorded</td></tr>'}</tbody></table>
</div>
<div class="panel">
<h2 style="margin-top:0">Recent flips</h2>
<table><thead><tr><th>when</th><th>bot</th><th>result</th><th>wager</th><th>opponent</th><th>Δ balance</th><th>detected by</th></tr></thead><tbody>${flips || '<tr><td colspan="7" class="empty">no flips yet</td></tr>'}</tbody></table>
</div>`
}

// ── Deep dissection ──────────────────────────────────────────────────────────

function deepRows (section) {
  return section.rows.map(row => {
    const flag = row.significant
      ? '<span class="pill good">survives</span>'
      : row.lowSample ? '<span class="pill dim">low n</span>' : ''
    return `<tr class="${row.significant ? 'sig' : ''}">
<td>${esc(row.label)}</td>
<td class="num">${row.n == null ? '–' : row.n}</td>
<td class="num">${row.rate == null ? esc(row.note || '–') : `${row.wins}W/${row.losses}L`}</td>
<td class="num">${row.rate == null ? '–' : pct(row.rate, 1)}</td>
<td class="num">${row.ci == null ? '–' : `${pct(row.ci.low, 1)}–${pct(row.ci.high, 1)}`}</td>
<td class="num">${row.p == null ? '–' : row.p.toExponential(1)}</td>
<td class="num">${row.q == null ? '–' : row.q.toExponential(1)}</td>
<td>${flag}</td></tr>`
  }).join('')
}

/**
 * Every dissection, all rendered from the same `sections` shape the report
 * carries — the page never recomputes a statistic, so what is on screen is
 * exactly what /bot-coinflip deep printed and /api/coinflip/deep serves.
 */
function deepSection (deep) {
  if (!deep || !deep.resolved) {
    return `<h2>Deep dissection</h2><div class="panel"><div class="empty">No resolved coinflips recorded yet. Run <code>/bot-coinflip run</code> and every dissection fills in here.</div></div>`
  }
  const controls = deep.sections.filter(section => section.rows.length || section.summary)
  const parts = controls.map(section => {
    const heading = `<div class="panel" style="margin-bottom:12px">
<h2 style="margin-top:0">${esc(section.title)}</h2>
<p class="sub" style="margin:0 0 8px">${esc(section.question || '')}</p>
${section.rows.length
  ? `<table><thead><tr><th>bucket</th><th>n</th><th>W/L</th><th>rate</th><th>95% CI</th><th>p</th><th>q</th><th></th></tr></thead><tbody>${deepRows(section)}</tbody></table>`
  : `<div class="empty">${esc(section.summary || 'no data')}</div>`}
<p class="sub" style="margin:8px 0 0">${esc(section.summary || '')}</p>
</div>`
    return heading
  }).join('')

  return `<h2>Deep dissection</h2>
<div class="kpis">
${kpi('resolved flips', fmt(deep.resolved))}
${kpi('win rate', pct(deep.winRate, 2))}
${kpi('statistical tests', fmt(deep.tests))}
${kpi('FDR level', esc(String(deep.q)))}
${kpi('P(win | win)', pct(deep.markov && deep.markov.pWinAfterWin, 2))}
${kpi('P(win | loss)', pct(deep.markov && deep.markov.pWinAfterLoss, 2))}
${kpi('lag-1 correlation', deep.autocorrelation && deep.autocorrelation[0] && deep.autocorrelation[0].r != null ? deep.autocorrelation[0].r.toFixed(4) : '–')}
${kpi('hour clock', esc(deep.hourSource || 'none'))}
${kpi('deepest drawdown', fmt(deep.curve && deep.curve.maxDrawdown), 'loss')}
${kpi('longest stretch below a high', `${deep.curve ? deep.curve.longestDrawdown : '–'} flips`)}
</div>
<div class="panel" style="margin-top:12px">
<h2 style="margin-top:0">What the numbers say</h2>
<ul class="takeaways">${(deep.takeaways || []).map(line => `<li>${esc(line)}</li>`).join('')}</ul>
<p class="sub" style="margin:8px 0 0">${deep.tests} bucket(s) and trend(s) were tested; the q column is the p-value after the Benjamini–Hochberg correction over all ${deep.tests} of them. A bucket under ${deep.minBucket} flips is marked low n and should be read as an anecdote. <a href="/api/coinflip/deep">/api/coinflip/deep</a> has the same numbers as JSON.</p>
</div>
${parts}`
}

function timeseriesSection (ts, bucketMs) {
  if (!ts || !ts.totalSamples) {
    return `<h2>Fleet over time</h2><div class="panel"><div class="empty">No samples yet. Samples are taken every ${esc(duration(bucketMs))} while the bot runs, after each <code>/data</code> or <code>/spawners</code> pass, and on <code>/timeseries sample</code>.</div></div>`
  }
  const s = ts.series || {}
  const sum = ts.summary || {}
  const latestRows = (ts.bots || []).map(bot => {
    const row = (ts.latest || {})[bot] || {}
    return `<tr><td>${esc(bot)}</td><td class="num">${esc(fmt(row.shards))}</td><td class="num">${esc(fmt(row.coins))}</td><td class="num">${esc(fmt(row.balance, 2))}</td><td>${esc(row.rank || '–')}</td><td class="num">${row.banned ? '🔨' : '–'}</td><td class="num">${row.invUsed == null ? '–' : `${row.invUsed}/${row.invTotal}`}</td></tr>`
  }).join('')
  const eventRows = (ts.events?.bans || []).slice(-15).reverse().map(e => `<tr><td>${esc(fmtTime(e.t))}</td><td>${esc(e.bot)}</td><td class="${e.banned ? 'loss' : 'win'}">${e.banned ? 'banned' : 'unbanned'}</td></tr>`).join('')
  const rankRows = (ts.events?.ranks || []).slice(-15).reverse().map(e => `<tr><td>${esc(fmtTime(e.t))}</td><td>${esc(e.bot)}</td><td>${esc(e.previous || '–')} → <b>${esc(e.rank)}</b></td></tr>`).join('')

  return `<h2>Fleet over time</h2>
<div class="kpis">
${kpi('tracked bots', (ts.bots || []).length)}
${kpi('samples', fmt(ts.totalSamples))}
${kpi('shards now', fmt(sum.shards?.last))}
${kpi('shards Δ window', fmt(sum.shards?.delta), (sum.shards?.delta || 0) >= 0 ? 'win' : 'loss')}
${kpi('balance now', fmt(sum.balance?.last, 2))}
${kpi('balance Δ window', fmt(sum.balance?.delta, 2), (sum.balance?.delta || 0) >= 0 ? 'win' : 'loss')}
${kpi('regent ranks', sum.regents?.last ?? '–')}
${kpi('banned bots', sum.banned?.last ?? '–')}
</div>
<div class="charts" style="margin-top:12px">
${lineChart(s.shards, { label: 'Shards (fleet)', color: 'var(--cyan)' })}
${lineChart(s.coins, { label: 'Coins (fleet)', color: 'var(--yel)' })}
${lineChart(s.balance, { label: 'Balance (fleet, $)', color: 'var(--grn)' })}
${lineChart(s.regents, { label: 'Regent ranks', color: 'var(--mag)' })}
${lineChart(s.banned, { label: 'Banned bots', color: 'var(--red)' })}
</div>
<div class="panel" style="margin-top:12px">
<h2 style="margin-top:0">Latest per bot</h2>
<table><thead><tr><th>bot</th><th>shards</th><th>coins</th><th>balance</th><th>rank</th><th>ban</th><th>inv</th></tr></thead><tbody>${latestRows || '<tr><td colspan="7" class="empty">no per-bot samples yet</td></tr>'}</tbody></table>
</div>
<div class="charts">
<div class="panel"><h2 style="margin-top:0">Ban events</h2><table><thead><tr><th>when</th><th>bot</th><th>state</th></tr></thead><tbody>${eventRows || '<tr><td colspan="3" class="empty">none recorded</td></tr>'}</tbody></table></div>
<div class="panel"><h2 style="margin-top:0">Rank changes</h2><table><thead><tr><th>when</th><th>bot</th><th>change</th></tr></thead><tbody>${rankRows || '<tr><td colspan="3" class="empty">none recorded</td></tr>'}</tbody></table></div>
</div>`
}

function renderHtml (report) {
  const h = report.headline || {}
  const bucketMs = (report.timeseries && report.timeseries.bucketMs) || 3600000
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFK Analytics</title>
<style>${STYLE}</style></head><body>
<h1>⛏ AFK <b>ANALYTICS</b></h1>
<p class="sub">generated ${esc(fmtTime(report.generatedAt))} · read-only · data files: <code>${esc((report.config && report.config.coinflipFile) || 'data/coinflip-history.jsonl')}</code> and <code>${esc((report.config && report.config.timeseriesFile) || 'data/timeseries.jsonl')}</code></p>
<div class="kpis">
${kpi('coinflips', fmt(h.coinflips))}
${kpi('coinflip net', fmt(h.coinflipNet), (h.coinflipNet || 0) >= 0 ? 'win' : 'loss')}
${kpi('win rate', pct(h.coinflipWinRate))}
${kpi('fairness', h.coinflipVerdict || '–', verdictClass(h.coinflipVerdict))}
${kpi('tracked bots', fmt(h.trackedBots))}
${kpi('samples', fmt(h.samples))}
${kpi('shards now', fmt(h.shardsNow))}
</div>
${coinflipSection(report.coinflip)}
${deepSection(report.deep)}
${timeseriesSection(report.timeseries, bucketMs)}
<p class="sub" style="margin-top:22px">JSON: <a href="/api/analytics">/api/analytics</a> · coinflips only: <a href="/api/coinflip">/api/coinflip</a> · series: <a href="/api/timeseries?metric=shards&amp;bucket=1h">/api/timeseries?metric=shards&amp;bucket=1h</a></p>
</body></html>`
}

/** Parses "1h" / "30m" / "15m" / "3600000" into milliseconds. */
function parseBucket (raw, fallback = 3600000) {
  if (raw == null || raw === '') return fallback
  const text = String(raw).trim().toLowerCase()
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/)
  if (!match) return fallback
  // A bare number is milliseconds; a suffixed one is that unit.
  const unit = match[2] || 'ms'
  const scale = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]
  return Math.max(1000, Math.round(Number(match[1]) * scale))
}

module.exports = {
  buildReport,
  buildHeadline,
  renderHtml,
  deepSection,
  lineChart,
  rateBar,
  parseBucket,
  esc,
  fmt,
  pct,
  fmtTime,
  duration,
  verdictClass
}
