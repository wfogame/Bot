# AI Chat Error Handling Improvements

## Problem
User reported AI chat saying "404" or errors out of context.

## Solution Implemented

### 1. Robust Error Handling in `ai-chat.js`

**Multi-layer fallback strategy:**
- **Primary**: Try `/chat/completions` with standard OpenAI format
- **Secondary**: Try `/responses` endpoint (Anthropic-compatible)
- **Tertiary**: Try `/chat/completions` without model field
- **Final fallback**: Return random Minecraft message

**Added proper logging:**
```javascript
console.error('FreeLLM /chat/completions error:', error.message);
console.error('FreeLLM /responses error:', error2.message);
console.error('FreeLLM fallback error:', error3.message);
console.log('Using fallback Minecraft message');
```

### 2. User-Friendly Error Messages in `bot.js`

**Specific error handling for common issues:**

```javascript
// 404 Not Found - endpoint doesn't exist
if (err.message?.includes('404') || err.message?.includes('Not Found')) {
  logFor(id, `{yellow-fg}⚠ AI chat endpoint not found (404) — check FREE_LLM_BASE_URL in .env${/yellow-fg}`)
  logFor(id, `{gray-fg}⚠ Falling back to random Minecraft messages${/gray-fg}`)
}

// Connection refused - server unreachable  
else if (err.message?.includes('ECONNREFUSED') || err.message?.includes('connection refused')) {
  logFor(id, `{yellow-fg}⚠ AI chat server unreachable — check FREE_LLM_BASE_URL${/yellow-fg}`)
  logFor(id, `{gray-fg}⚠ Falling back to random Minecraft messages${/gray-fg}`)
}

// Other errors - show red warning
else {
  logFor(id, `{red-fg}✗ AI chat error: ${sanitize(err.message)}{/red-fg}`)
}
```

### 3. Test Script Created

**`test-ai-chat.js`** - Tests all three endpoints:
- `/chat/completions` with model
- `/responses` endpoint
- `/chat/completions` without model

Run with: `node test-ai-chat.js`

### 4. Behavior When Errors Occur

**Instead of crashing or showing "404" to users:**
1. Error is logged to console
2. Bot continues running
3. Falls back to pre-defined Minecraft messages
4. User sees helpful warning in dashboard
5. AI chat continues with random messages

### 5. Files Modified

- `ai-chat.js` - Enhanced error handling with multiple fallbacks
- `bot.js` - Specific error messages for 404 and connection errors
- `test-ai-chat.js` - New test script (created)

### 6. Testing Instructions

**Manual test with wrong URL:**
1. Set `FREE_LLM_BASE_URL=http://localhost:9999` (invalid)
2. Start bot
3. Run `/ai-chat start`
4. Should see yellow warning about server unreachable
5. Should continue with random Minecraft messages

**Manual test with valid URL:**
1. Set correct `FREE_LLM_BASE_URL` and `FREE_LLM_API_KEY`
2. Run `/ai-chat start`
3. Should see AI messages in chat
4. Should see cyan "AI says: ..." in logs

**Run test script:**
```bash
node test-ai-chat.js
```
