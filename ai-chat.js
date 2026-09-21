const axios = require('axios');

// FreeLLM API configuration - REQUIRED env vars, no defaults
const FREE_LLM_API_KEY = process.env.FREE_LLM_API_KEY;
const FREE_LLM_BASE_URL = process.env.FREE_LLM_BASE_URL;

if (!FREE_LLM_API_KEY) {
  console.error('[ai-chat] ERROR: FREE_LLM_API_KEY environment variable is required');
  process.exit(1);
}
if (!FREE_LLM_BASE_URL) {
  console.error('[ai-chat] ERROR: FREE_LLM_BASE_URL environment variable is required');
  process.exit(1);
}

// Configure axios to use the base URL
const freeLLMClient = axios.create({
  baseURL: FREE_LLM_BASE_URL,
  headers: {
    'Authorization': `Bearer ${FREE_LLM_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// System prompt template - filled in with actual bot name
function getRedstoneProSystemPrompt(botName) {
  return `You are RedStonePro, but you are playing as "${botName}" right now.
You are a hyper-aggressive Minecraft player who speaks casually with occasional grammar mistakes.

CRITICAL RULES:
- IMMEDIATELY start talking as RedStonePro. NO "Yes I understand", NO "I am now...", NO explanation. JUST speak.
- Use Minecraft slang and casual language
- Respond in 8 words or less
- Do NOT use names of players in your responses
- NO thinking, NO meta-commentary
- Be aggressive and casual
- YOUR ENTIRE RESPONSE MUST BE A SINGLE DOUBLE-QUOTED STRING. Example: "nice loot today"
- NO punctuation outside the quotes. NO extra text. NOTHING but the quoted message.
- If your response is not exactly one quoted string, you have FAILED.

IMPORTANT: When the user message mentions a player chat, respond to THAT message naturally as if you heard it in Minecraft chat. `;
}

// Call FreeLLM API for chat completion - returns ONLY the quoted message content
async function callFreeLLMChat(latestChatMessage = '', botName = 'the bot') {
  const systemPrompt = getRedstoneProSystemPrompt(botName);
  const userPrompt = latestChatMessage
    ? `The player just said this in chat: "${latestChatMessage}"\n\nRespond naturally to this as RedStonePro. Remember: ONLY output a single quoted string.`
    : 'Generate a casual Minecraft message to say in chat. Remember: ONLY output a single quoted string.';

  const endpoints = [
    { path: '/chat/completions', body: { model: 'auto', messages: [] } },
    { path: '/responses', body: { model: 'auto', messages: [] } },
    { path: '/chat/completions', body: { messages: [] } }
  ];

  for (const ep of endpoints) {
    try {
      const body = { ...ep.body, max_tokens: 100, temperature: 0.8 };
      if (ep.body.messages.length === 0) {
        body.messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ];
      }
      const response = await freeLLMClient.post(ep.path, body);
      let content = '';
      if (ep.path === '/responses') {
        content = response.data?.outputs?.[0]?.text || '';
      } else {
        content = response.data?.choices?.[0]?.message?.content?.trim() || '';
      }
      // Extract ONLY the quoted content
      const quoted = extractQuotedContent(content);
      if (quoted) return quoted;
      console.error(`[ai-chat] Response missing quoted content from ${ep.path}:`, content.slice(0, 200));
    } catch (error) {
      console.error(`FreeLLM ${ep.path} error:`, error.message);
    }
  }

  // All endpoints failed - return fallback
  console.log('[ai-chat] All endpoints failed, using fallback message');
  return generateMinecraftChatMessage();
}

// Extract the FIRST double-quoted string from response
function extractQuotedContent(text) {
  if (!text) return null;
  const match = text.match(/^"([^"]*)"$/);
  if (match) return match[1];
  // Fallback: find first quoted substring
  const fallback = text.match(/"([^"]+)"/);
  if (fallback) return fallback[1];
  return null;
}

// Get available models from FreeLLM API
async function getAvailableModels() {
  try {
    const response = await freeLLMClient.get('/models');
    return response.data?.data?.map(model => ({
      id: model.id,
      owned_by: model.owned_by || 'unknown',
      max_model_len: model.max_model_len || 0,
      description: model.description || ''
    })) || [];
  } catch (error) {
    console.error('FreeLLM get models error:', error.message);
    return [];
  }
}

// Minecraft-themed chat messages with random grammar mistakes
const MINECRAFT_CHAT_MESSAGES = [
  // Normal messages with occasional grammar errors
  'Nice day for mining, isnt it?',
  'Gimme loot!',
  'Drop it!',
  'GIVE IT UP',
  'Something smells fishy...',
  'Huh, interesting block',
  'Wait, is that a creeper?',
  'Oof, that hurt',
  'Let me check my inventory',
  'I think I got something here',
  'Better run!',
  'That TNT is suspicious',
  'Redstone power? No way',
  'Is this safe?',
  'Pretty good loot day',
  'Bread and apples again?',
  'Gold ore! Finally!',
  'That villager is making no sense',
  'Ender pearls!',
  'Why is it always rain at night?',
  // Messages with intentional grammar mistakes
  'hehe, random grammar here',
  'gimme those stuffs',
  'this thing is broken',
  'wai, what?',
  'no wayy, that cant be right',
  'yeah i think so',
  'maybe? perhaps?',
  'lemme check...',
  'nah, nevermind',
  'hmm, interesting',
  'nah thats bad',
  'maybe try agian?',
  'eh, not good enough',
  'yea sounds good',
  'huh?',
  'nah i dont think so',
  'hmm maybe',
  'yea whatever',
  'nah thats wrong',
  'wait what?',
  'eh, close enough'
];

// Generate a chat message with random grammar mistakes
function generateMinecraftChatMessage() {
  const messages = [...MINECRAFT_CHAT_MESSAGES];
  const randomIndex = Math.floor(Math.random() * messages.length);
  return messages[randomIndex];
}

// Generate a random delay between min and max seconds
function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

// Auto AI chat handler - chats every 40-150 seconds
const AI_CHAT_INTERVAL_MIN_MS = 40 * 1000;
const AI_CHAT_INTERVAL_MAX_MS = 150 * 1000;

async function autoAIChatLoop(bot, send, botName) {
  console.log('[ai-chat] Starting Auto AI Chat loop');

  while (true) {
    const delay = Math.floor(Math.random() * (AI_CHAT_INTERVAL_MAX_MS - AI_CHAT_INTERVAL_MIN_MS)) + AI_CHAT_INTERVAL_MIN_MS;
    console.log(`[ai-chat] Waiting ${delay / 1000}s before next AI chat...`);
    await new Promise(resolve => setTimeout(resolve, delay));

    const message = await callFreeLLMChat('', botName);
    if (message && bot?.entity) {
      console.log(`[ai-chat] AI says: ${message}`);
      send(message);
    }
  }
}

// Export functions for use in bot.js
module.exports = {
  callFreeLLMChat,
  getAvailableModels,
  generateMinecraftChatMessage,
  autoAIChatLoop,
  AI_CHAT_INTERVAL_MIN_MS,
  AI_CHAT_INTERVAL_MAX_MS,
  FREE_LLM_API_KEY,
  FREE_LLM_BASE_URL
};
