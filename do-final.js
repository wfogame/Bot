const fs = require('fs');

let bot = fs.readFileSync('bot.js', 'utf8');
const newPageHtmlFull = fs.readFileSync('coinflip-dashboard-pagehtml.txt', 'utf8');

// Extract template from new file
const newTemplateStart = newPageHtmlFull.indexOf('`');
const newTemplateEnd = newPageHtmlFull.lastIndexOf('`');
const newTemplate = newPageHtmlFull.slice(newTemplateStart, newTemplateEnd + 1);
console.log('New template length:', newTemplate.length);

// ===== 1. Add require =====
bot = bot.replace(
  "const analytics = require(path.join(__dirname, 'analytics'))\nconst mineflayer = require('mineflayer')",
  "const analytics = require(path.join(__dirname, 'analytics'))\nconst { handleChartJs, handleCoinflipDashboardJs } = require('./coinflip-dashboard-static')\nconst mineflayer = require('mineflayer')"
);

// ===== 2. Replace PAGE_HTML =====
const PAGE_HTML_START = 'const PAGE_HTML = `';
const startIdx = bot.indexOf(PAGE_HTML_START);
if (startIdx === -1) { console.error('PAGE_HTML start not found'); process.exit(1); }

const serverComment = '// ── Web GUI server (native http + ws, session-cookie auth)';
const commentIdx = bot.indexOf(serverComment, startIdx);
if (commentIdx === -1) { console.error('Server comment not found'); process.exit(1); }

// Find the backtick before the comment
let endIdx = commentIdx - 1;
while (endIdx > startIdx && /\s/.test(bot[endIdx])) endIdx--;
if (bot[endIdx] !== '`') { console.error('Backtick not found before comment'); process.exit(1); }

const prefix = bot.slice(0, startIdx + PAGE_HTML_START.length - 1);
const after = bot.slice(endIdx + 1);
bot = prefix + newTemplate + after;

// ===== 3. Add routes =====
const routeMarker = "webTrace('serving minecraft web client page')\nres.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })\nres.end(playPageHtml(clientBaseFor(req)))\nreturn\n}\nres.writeHead(404); res.end('not found')";

const routeIdx = bot.indexOf(routeMarker);
if (routeIdx === -1) { console.error('Route marker not found'); process.exit(1); }

const newRoutes = `webTrace('serving minecraft web client page')
res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(playPageHtml(clientBaseFor(req)))
return
}
if (p === '/api/coinflip/summary' && req.method === 'GET') {
  sendJson(res, coinflipStore.summary({ recent: 100, minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') }))
  return
}
if (p === '/api/coinflip/bot' && req.method === 'GET') {
  const botName = url.searchParams.get('bot') || null
  if (!botName) { sendJson(res, { ok: false, error: 'bot parameter required' }, 400); return }
  const rows = coinflipStore.all().filter(r => r.bot === botName)
  const summary = coinflipStore.summary({ recent: 100, minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  sendJson(res, { bot: botName, rows, summary })
  return
}
if (p === '/api/coinflip/fairness' && req.method === 'GET') {
  const rows = coinflipStore.all()
  const fairness = coinflip.analyzeFairness(rows, { minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  sendJson(res, fairness)
  return
}
if (p === '/api/coinflip/deep' && req.method === 'GET') {
  const botName = url.searchParams.get('bot') || null
  const deep = coinflipDeepReport({ bot: botName })
  sendJson(res, deep)
  return
}
if (p === '/api/coinflip/bots' && req.method === 'GET') {
  const rows = coinflipStore.all()
  const botsMap = {}
  for (const row of rows) {
    if (!botsMap[row.bot]) botsMap[row.bot] = { flips: 0, wins: 0, losses: 0, net: 0, lastSeen: 0 }
    botsMap[row.bot].flips++
    if (row.result === 'win') botsMap[row.bot].wins++
    else if (row.result === 'loss') botsMap[row.bot].losses++
    botsMap[row.bot].net += row.delta || 0
    botsMap[row.bot].lastSeen = Math.max(botsMap[row.bot].lastSeen, row.ts || 0)
  }
  sendJson(res, { bots: botsMap })
  return
}
if (p === '/chart.js' && req.method === 'GET') {
  handleChartJs(req, res)
  return
}
if (p === '/coinflip-dashboard.js' && req.method === 'GET') {
  handleCoinflipDashboardJs(req, res)
  return
}
res.writeHead(404); res.end('not found')`;

bot = bot.slice(0, routeIdx) + newRoutes + bot.slice(routeIdx + routeMarker.length);

fs.writeFileSync('bot.js', bot);
console.log('Done');