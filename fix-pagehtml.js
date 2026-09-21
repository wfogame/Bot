const fs = require('fs');

const oldBot = fs.readFileSync('bot.js', 'utf8');
const newPageHtml = fs.readFileSync('coinflip-dashboard-pagehtml.txt', 'utf8');

// Find the SECOND occurrence of the start marker (PAGE_HTML, not LOGIN_HTML)
const startMarker = 'const PAGE_HTML = `';
let count = 0;
let startIdx = -1;
let pos = 0;
while (true) {
  const idx = oldBot.indexOf(startMarker, pos);
  if (idx === -1) break;
  count++;
  if (count === 2) {
    startIdx = idx;
    break;
  }
  pos = idx + 1;
}

if (startIdx === -1) { 
  console.error('PAGE_HTML start not found (expected 2nd occurrence)');
  process.exit(1); 
}

console.log('Found PAGE_HTML at index:', startIdx);

// Find the end of the template literal - it ends with ` followed by newline
let i = startIdx + startMarker.length;
let inString = false;
let stringChar = '';
let endIdx = -1;
while (i < oldBot.length) {
  const ch = oldBot[i];
  const prev = oldBot[i-1];
  
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

const before = oldBot.slice(0, startIdx);
const after = oldBot.slice(endIdx + 1);
const result = before + newPageHtml + after;

fs.writeFileSync('bot.js', result);
console.log('PAGE_HTML replaced successfully (2nd occurrence)');