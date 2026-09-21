const fs = require('fs');

const botJs = fs.readFileSync('/tmp/Bot/bot.js', 'utf8');
const staticJs = fs.readFileSync('/tmp/Bot/coinflip-dashboard-static.js', 'utf8');
const pageHtml = fs.readFileSync('/tmp/Bot/coinflip-dashboard-pagehtml.txt', 'utf8');

let result = botJs;

// 1. Add require for the static module
const analyticsRequire = "const analytics = require(path.join(__dirname, 'analytics'))";
const newRequire = "const analytics = require(path.join(__dirname, 'analytics'))\nconst { handleChartJs, handleCoinflipDashboardJs } = require('./coinflip-dashboard-static')";

result = result.replace(analyticsRequire, newRequire);

// 2. Replace PAGE_HTML
const pageHtmlContent = fs.readFileSync('/tmp/Bot/coinflip-dashboard-pagehtml.txt', 'utf8');
const pageHtmlStart = "const PAGE_HTML = `";
const pageHtmlIdx = botJs.indexOf(pageHtmlStart, 1000);

let i = pageHtmlIdx + 21;
let inString = false;
let stringChar = '';
let endIdx = -1;
while (i < botJs.length) {
  const ch = botJs[i];
  const prev = botJs[i-1];
  if (!inString) {
    if (ch === '`') { endIdx = i; break; }
    else if (ch === '"' || ch === "'") { inString = true; stringChar = ch; }
  } else {
    if (ch === stringChar && prev !== '\\') inString = false;
  }
  i++;
}

const before = botJs.slice(0, pageHtmlIdx);
const after = botJs.slice(endIdx + 1);
const newBot = before + pageHtml + after;

// 4. Add route handlers
const fourOhFourPattern = "res.writeHead(404); res.end('not found')";
const fourOhFourIdx = result.indexOf(fourOhFourPattern);
const newRoutes = `if (p === '/chart.js' && req.method === 'GET') {
  handleChartJs(req, res)
  return
}
if (p === '/coinflip-dashboard.js' && req.method === 'GET') {
  handleCoinflipDashboardJs(req, res)
  return
}
`;

const finalResult = result.slice(0, fourOhFourIdx) + newRoutes + result.slice(fourOhFourIdx);

require('fs').writeFileSync('/tmp/Bot/bot.js', finalResult);
console.log('Integration complete');
