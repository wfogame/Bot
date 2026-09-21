const fs = require('fs');
const path = require('path');

const CHART_JS_PATH = path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
let chartJsCache = null;

function getChartJs() {
  if (!chartJsCache) {
    try {
      chartJsCache = fs.readFileSync(CHART_JS_PATH, 'utf8');
    } catch (err) {
      console.error('[coinflip-dashboard] Failed to load chart.js:', err.message);
      chartJsCache = '';
    }
  }
  return chartJsCache;
}

function getCoinflipDashboardJs() {
  return `(function() {
  'use strict';
  let currentTab = 'overview';
  let botsList = [];

  const cfkpi = document.getElementById('cfkpi');
  const cfbotlist = document.getElementById('cfbotlist');
  const cftabs = document.getElementById('cftabs');
  const cfcontent = document.getElementById('cfcontent');
  const cfclose = document.getElementById('cfclose');
  const coinflipbtn = document.getElementById('coinflipbtn');
  const coinflippanel = document.getElementById('coinflippanel');

  async function init() {
    await loadBots();
    renderTabs();
    loadOverview();

    if (coinflipbtn) coinflipbtn.onclick = () => { coinflippanel.hidden = false; };
    if (cfclose) cfclose.onclick = () => { coinflippanel.hidden = true; };

    if (cftabs) cftabs.addEventListener('click', e => {
      if (e.target.classList.contains('cftab')) {
        currentTab = e.target.dataset.tab;
        updateTabContent();
      }
    });
  }

  async function loadBots() {
    try {
      const resp = await fetch('/api/coinflip/bots', { credentials: 'same-origin' });
      const data = await resp.json();
      botsList = Object.entries(data.bots || {}).map(([id, stats]) => ({ id, ...stats }));
      renderBotList();
    } catch (err) {
      console.error('Failed to load bots:', err);
    }
  }

  function renderBotList() {
    if (!cfbotlist) return;
    cfbotlist.innerHTML = '';
    botsList.forEach(bot => {
      const div = document.createElement('div');
      div.className = 'bot-item';
      div.style = 'display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line);';
      const winRate = bot.flips ? ((bot.wins || 0) / bot.flips * 100).toFixed(1) : 0;
      div.innerHTML = '<span>' + bot.id + '</span><span>Flips: ' + (bot.flips || 0) + ', Win Rate: ' + winRate + '%</span>';
      cfbotlist.appendChild(div);
    });
  }

  function renderTabs() {
    if (!cftabs) return;
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'perbot', label: 'Per Bot' },
      { id: 'fairness', label: 'Fairness' },
      { id: 'deep', label: 'Deep Stats' }
    ];
    cftabs.innerHTML = '';
    tabs.forEach(tab => {
      const button = document.createElement('button');
      button.className = 'cftab';
      button.dataset.tab = tab.id;
      button.textContent = tab.label;
      if (tab.id === currentTab) button.classList.add('on');
      cftabs.appendChild(button);
    });
  }

  async function updateTabContent() {
    renderTabs();
    switch (currentTab) {
      case 'overview': await loadOverview(); break;
      case 'perbot': await loadPerBot(); break;
      case 'fairness': await loadFairness(); break;
      case 'deep': await loadDeep(); break;
    }
  }

  async function loadOverview() {
    try {
      const resp = await fetch('/api/coinflip/summary', { credentials: 'same-origin' });
      const summary = await resp.json();
      if (!cfkpi) return;
      cfkpi.innerHTML = 
        '<div class="kpi"><div>Total Flips</div><div class="value">' + (summary.stats?.total || 0) + '</div></div>' +
        '<div class="kpi"><div>Win Rate</div><div class="value">' + (summary.stats?.winRate || 0).toFixed(1) + '%</div></div>' +
        '<div class="kpi"><div>Net P&L</div><div class="value">' + (summary.stats?.net || 0) + '</div></div>' +
        '<div class="kpi"><div>Tracked Bots</div><div class="value">' + (summary.stats?.trackedBots || 0) + '</div></div>' +
        '<div class="kpi"><div>Current Streak</div><div class="value">' + (summary.stats?.currentStreak || 0) + '</div></div>' +
        '<div class="kpi"><div>Best Streak</div><div class="value">' + (summary.stats?.bestStreak || 0) + '</div></div>';
    } catch (err) {
      console.error('Failed to load overview:', err);
    }
  }

  async function loadPerBot() {
    if (!cfcontent) return;
    cfcontent.innerHTML = '<p>Per-bot detail view — select a bot from the list</p>';
  }

  async function loadFairness() {
    try {
      const resp = await fetch('/api/coinflip/fairness', { credentials: 'same-origin' });
      const fairness = await resp.json();
      if (!cfcontent) return;
      const items = Object.entries(fairness).map(([bot, p]) => {
        const verdict = p < 0.05 ? 'fail' : 'pass';
        return '<div><span>' + bot + ':</span> <span class="' + verdict + '">p = ' + p.toFixed(4) + '</span></div>';
      }).join('');
      cfcontent.innerHTML = '<div style="line-height:1.5;">' + items + '</div>';
    } catch (err) {
      console.error('Failed to load fairness:', err);
    }
  }

  async function loadDeep() {
    try {
      const resp = await fetch('/api/coinflip/deep', { credentials: 'same-origin' });
      const deep = await resp.json();
      if (!cfcontent) return;
      const tests = [
        { key: 'winStreakAfterLoss', label: 'Win Streak After Loss' },
        { key: 'lossStreakAfterWin', label: 'Loss Streak After Win' },
        { key: 'lagCorrelation', label: 'Lag Correlation' },
        { key: 'runLengthAnalysis', label: 'Run Length Analysis' },
        { key: 'markovAnalysis', label: 'Markov Analysis' },
        { key: 'streakHazardAnalysis', label: 'Streak Hazard Analysis' },
        { key: 'profitCapAnalysis', label: 'Profit Cap Analysis' },
        { key: 'simultaneousFlipAnalysis', label: 'Simultaneous Flip Analysis' },
        { key: 'opponentDisparityAnalysis', label: 'Opponent Disparity Analysis' },
        { key: 'benfordsLaw', label: "Benford's Law" },
        { key: 'poissonInterarrival', label: 'Poisson Inter-arrival' },
        { key: 'hiddenMarkovModel', label: 'Hidden Markov Model' }
      ];
      const rows = tests.map(t => {
        const section = deep[t.key] || {};
        const p = section.p || null;
        const verdict = p !== null && p < 0.05 ? 'fail' : 'pass';
        return '<div style="margin-bottom:8px;"><strong>' + t.label + ':</strong> <span class="' + verdict + '">p = ' + (p !== null ? p.toFixed(4) : 'n/a') + '</span>' + (section.note ? '<br><small>' + section.note + '</small>' : '') + '</div>';
      }).join('');
      cfcontent.innerHTML = '<div style="line-height:1.5;">' + rows + '</div>';
    } catch (err) {
      console.error('Failed to load deep analysis:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;
}

function handleChartJs(req, res) {
  const js = getChartJs();
  res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
  res.end(js);
}

function handleCoinflipDashboardJs(req, res) {
  const js = getCoinflipDashboardJs();
  res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
  res.end(js);
}

module.exports = { getChartJs, getCoinflipDashboardJs, handleChartJs, handleCoinflipDashboardJs };