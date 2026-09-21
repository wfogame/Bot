const fs = require('fs');

const oldBot = fs.readFileSync('bot.js', 'utf8');
const newPageHtmlFull = fs.readFileSync('coinflip-dashboard-pagehtml.txt', 'utf8');

// Extract just the template literal from the new file (remove "const PAGE_HTML = " prefix and trailing backtick)
const newTemplateStart = newPageHtmlFull.indexOf('`');
const newTemplateEnd = newPageHtmlFull.lastIndexOf('`');
if (newTemplateStart === -1 || newTemplateEnd === -1 || newTemplateStart === newTemplateEnd) {
  console.error('Could not extract template from new file');
  process.exit(1);
}
const newTemplate = newPageHtmlFull.slice(newTemplateStart, newTemplateEnd + 1);
console.log('Extracted new template, length:', newTemplate.length);

// ===== Step 1: Add the require =====
let result = oldBot.replace(
  "const analytics = require(path.join(__dirname, 'analytics'))\nconst mineflayer = require('mineflayer')",
  "const analytics = require(path.join(__dirname, 'analytics'))\nconst { handleChartJs, handleCoinflipDashboardJs } = require('./coinflip-dashboard-static')\nconst mineflayer = require('mineflayer')"
);

// ===== Step 2: Replace PAGE_HTML template literal =====
const startMarker = 'const PAGE_HTML = `';
let pos = 0;
let startIdx = -1;
while (true) {
  const idx = result.indexOf(startMarker, pos);
  if (idx === -1) break;
  const contextStart = Math.max(0, idx - 50);
  const context = result.slice(contextStart, idx + 30);
  if (context.includes('PAGE_HTML')) {
    startIdx = idx;
    break;
  }
  pos = idx + 1;
}

if (startIdx === -1) { 
  console.error('PAGE_HTML start not found');
  process.exit(1); 
}

console.log('Found PAGE_HTML at index:', startIdx);

// Find the end of the template literal
let i = startIdx + startMarker.length;
let inString = false;
let stringChar = '';
let endIdx = -1;
while (i < result.length) {
  const ch = result[i];
  const prev = result[i-1];
  
  if (!inString) {
    if (ch === '`') {
      endIdx = i;
      break;
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    }
  } else {
    if (ch === stringChar && prev !== '\\') {
      inString = false;
    }
  }
  i++;
}

if (endIdx === -1) { console.error('End not found'); process.exit(1); }

console.log('End index:', endIdx);

// Replace: keep "const PAGE_HTML = " and replace the template literal
const prefix = result.slice(0, startIdx + startMarker.length - 1); // includes "const PAGE_HTML = "
const after = result.slice(endIdx + 1);
result = prefix + newTemplate + after;

// ===== Step 3: Add the API routes and static file routes =====
const routeMarker = "webTrace('serving minecraft web client page')\nres.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })\nres.end(playPageHtml(clientBaseFor(req)))\nreturn\n}\nres.writeHead(404); res.end('not found')";

const routeIdx = result.indexOf(routeMarker);
if (routeIdx === -1) {
  console.error('Route marker not found');
  process.exit(1);
}

console.log('Found route marker at:', routeIdx);

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
  const bot = url.searchParams.get('bot') || null
  if (!bot) { sendJson(res, { ok: false, error: 'bot parameter required' }, 400); return }
  const rows = coinflipStore.all().filter(r => r.bot === bot)
  const summary = coinflipStore.summary({ recent: 100, minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  sendJson(res, { bot, rows, summary })
  return
}
if (p === '/api/coinflip/fairness' && req.method === 'GET') {
  const rows = coinflipStore.all()
  const fairness = coinflip.analyzeFairness(rows, { minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  sendJson(res, fairness)
  return
}
if (p === '/api/coinflip/deep' && req.method === 'GET') {
  const bot = url.searchParams.get('bot') || null
  const deep = coinflipDeepReport({ bot })
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

result = result.slice(0, routeIdx) + newRoutes + result.slice(routeIdx + routeMarker.length);

// Write the result
fs.writeFileSync('bot.js', result);
console.log('All changes applied successfully');