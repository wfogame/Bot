'use strict'

/**
 * FreeLLM chat generation for /ai-chat.
 *
 * Three rules drive this file:
 *
 *   1. NO prerecorded fallback. A canned line dropped into the middle of a
 *      live conversation is worse than silence — it is what makes a bot look
 *      like a bot. If the LLM cannot produce a message, the turn is skipped
 *      and reported; the loop keeps its cadence and tries again next turn.
 *   2. The last few chat messages the bot saw are passed to the model every
 *      turn, so the reply answers what was actually said instead of blurting
 *      a non sequitur.
 *   3. Whatever the model returns is extracted from its double quotes and
 *      VERIFIED before anything is sent to the server — the verified message
 *      is the only thing that ever reaches public chat.
 *
 * Configuration (FREE_LLM_API_KEY, FREE_LLM_BASE_URL, AI_CHAT_MODEL) is read
 * on every call from process.env: /env set and the dashboard .ENV tab write
 * process.env in memory, so a corrected key or model applies to the very next
 * turn instead of needing a restart.
 */

// How many completions one turn may burn before giving up on saying anything.
const AI_CHAT_MAX_ATTEMPTS = 3
// One request may never hang the loop forever.
const AI_CHAT_TIMEOUT_MS = 30000
// How many recent chat lines are passed to the model.
const AI_CHAT_CONTEXT_MESSAGES = 5

function aiChatConfig () {
  return {
    apiKey: (process.env.FREE_LLM_API_KEY || '').trim(),
    baseUrl: (process.env.FREE_LLM_BASE_URL || '').trim().replace(/\/+$/, ''),
    model: (process.env.AI_CHAT_MODEL || '').trim() || 'auto'
  }
}

function requireConfigured (config) {
  if (!config.apiKey || !config.baseUrl) {
    const err = new Error('AI chat is not configured: set FREE_LLM_API_KEY and FREE_LLM_BASE_URL in .env (or /env set them for this run)')
    err.code = 'AI_CHAT_NOT_CONFIGURED'
    throw err
  }
}

// System prompt template - filled in with actual bot name
function getRedstoneProSystemPrompt (botName, maxWords = 15) {
  return `You are RedStonePro, but you are playing as "${botName}" right now.
You are a hyper-aggressive Minecraft player who speaks casually with occasional grammar mistakes.

CRITICAL RULES:
- IMMEDIATELY start talking as RedStonePro. NO "Yes I understand", NO "I am now...", NO explanation. JUST speak.
- Use Minecraft slang and casual language
- Respond in ${maxWords} words or less
- Do NOT use names of players in your responses
- NO thinking, NO meta-commentary
- Be aggressive and casual
- YOUR ENTIRE RESPONSE MUST BE A SINGLE DOUBLE-QUOTED STRING. Example: "nice loot today"
- NO punctuation outside the quotes. NO extra text. NOTHING but the quoted message.
- Never begin the message with / or . — those look like commands and are rejected.

You are given the last few chat messages from the server. Answer the most recent one naturally, as if you heard it in Minecraft chat.`;
}

/** The user turn: the recent chat, verbatim, oldest first. */
function buildUserPrompt (recentChat) {
  const lines = (Array.isArray(recentChat) ? recentChat : recentChat ? [recentChat] : [])
    .map(line => String(line ?? '').trim())
    .filter(Boolean)
    .slice(-AI_CHAT_CONTEXT_MESSAGES)
  if (!lines.length) {
    return 'The chat has been quiet. Generate a casual Minecraft message to say in chat. Remember: ONLY output a single double-quoted string.'
  }
  return `The last ${lines.length} chat message(s) on the server, oldest first:\n` +
    lines.map((line, i) => `${i + 1}. ${line}`).join('\n') +
    '\n\nRespond naturally to the most recent message as RedStonePro. Remember: ONLY output a single double-quoted string.'
}

/**
 * Extract the FIRST double-quoted string from a response. A response that is
 * exactly one quoted string is the ideal, but a model that prefaced it with a
 * word should not cost a turn — verification is what keeps the chat safe.
 */
function extractQuotedContent (text) {
  if (!text) return null;
  const whole = String(text).trim().match(/^"([\s\S]*)"$/)
  if (whole) return whole[1]
  const span = String(text).match(/"([^"]+)"/)
  return span ? span[1] : null
}

/**
 * Verification is the gate between the LLM and public chat: whatever survives
 * this is what every player on the server sees under the bot's name. Color
 * codes and control characters are stripped, whitespace is collapsed, and a
 * message that looks like a command (/ or .) is refused outright — the same
 * exposure a mistyped broadcast has.
 */
function verifyChatMessage (raw, { maxWords = 15, maxLength = 256 } = {}) {
  if (raw == null) return { ok: false, reason: 'nothing quoted' }
  const message = String(raw)
    .replace(/\u00a7./g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!message) return { ok: false, reason: 'empty after cleanup' }
  if (message.length > maxLength) return { ok: false, reason: `longer than ${maxLength} characters` }
  const words = message.split(' ').filter(Boolean).length
  if (words > maxWords) return { ok: false, reason: `more than ${maxWords} words` }
  if (/^[/.]/.test(message)) return { ok: false, reason: 'starts with a command character' }
  return { ok: true, message }
}

/** Pull the completion text out of whatever shape the endpoint answered with. */
function extractResponseText (endpoint, data) {
  if (!data) return ''
  if (endpoint === '/responses') {
    return String(data.outputs?.[0]?.text ?? data.output_text ?? '').trim()
  }
  return String(data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '').trim()
}

async function postCompletion (fetchImpl, config, endpoint, body) {
  const response = await fetchImpl(config.baseUrl + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_CHAT_TIMEOUT_MS)
  })
  if (!response.ok) {
    const err = new Error(`FreeLLM ${endpoint} answered HTTP ${response.status}`)
    err.httpStatus = response.status
    throw err
  }
  return response.json()
}

/**
 * Call FreeLLM for one chat turn and return ONLY a verified quoted message.
 *
 * @param {string[]|string} recentChat - the last few chat lines the bot saw
 * @param {string} botName - the name to speak as
 * @param {{model?: string, maxWords?: number, attempts?: number, fetchImpl?: Function}} [opts]
 * @returns {Promise<string>} the verified message, ready to send
 * @throws when unconfigured, unreachable, or no attempt produced a message
 *   that passes verification — never a prerecorded fallback.
 */
async function callFreeLLMChat (recentChat = [], botName = 'the bot', opts = {}) {
  const config = aiChatConfig()
  requireConfigured(config)
  const { model, maxWords = 15, attempts = AI_CHAT_MAX_ATTEMPTS, fetchImpl } = opts
  const doFetch = fetchImpl || fetch

  const body = {
    model: model || config.model,
    messages: [
      { role: 'system', content: getRedstoneProSystemPrompt(botName, maxWords) },
      { role: 'user', content: buildUserPrompt(recentChat) }
    ],
    max_tokens: 100,
    temperature: 0.8
  }

  // /chat/completions is the OpenAI shape; /responses is accepted when the
  // server only speaks that dialect (404/405 on the first).
  let endpoint = '/chat/completions'
  let lastProblem = 'no response'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let content = ''
    try {
      const data = await postCompletion(doFetch, config, endpoint, body)
      content = extractResponseText(endpoint, data)
    } catch (error) {
      if (error.httpStatus === 404 || error.httpStatus === 405) {
        if (endpoint === '/chat/completions') {
          endpoint = '/responses'
          attempt-- // the dialect probe does not cost a real attempt
          continue
        }
      }
      lastProblem = error.message
      continue
    }
    const quoted = extractQuotedContent(content)
    if (!quoted) {
      lastProblem = `no quoted message in: ${content.slice(0, 120)}`
      continue
    }
    const verified = verifyChatMessage(quoted, { maxWords })
    if (!verified.ok) {
      lastProblem = `quoted message rejected (${verified.reason})`
      continue
    }
    return verified.message
  }
  const err = new Error(`AI chat produced no verifiable message after ${attempts} attempt(s) — ${lastProblem}`)
  err.code = 'AI_CHAT_NO_MESSAGE'
  throw err
}

// Get available models from FreeLLM API
async function getAvailableModels (opts = {}) {
  const config = aiChatConfig()
  if (!config.apiKey || !config.baseUrl) return []
  try {
    const doFetch = opts.fetchImpl || fetch
    const response = await doFetch(config.baseUrl + '/models', {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(AI_CHAT_TIMEOUT_MS)
    })
    if (!response.ok) return []
    const data = await response.json()
    return data?.data?.map(model => ({
      id: model.id,
      owned_by: model.owned_by || 'unknown',
      max_model_len: model.max_model_len || 0,
      description: model.description || ''
    })) || []
  } catch (error) {
    console.error('FreeLLM get models error:', error.message)
    return []
  }
}

// Generate a random delay between min and max seconds
function randomDelay (minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs)
}

// Auto AI chat handler - chats every 40-150 seconds
const AI_CHAT_INTERVAL_MIN_MS = 40 * 1000;
const AI_CHAT_INTERVAL_MAX_MS = 150 * 1000;

/**
 * Runs the AI chat loop for one bot until the caller stops it.
 *
 * @param {object} bot - the mineflayer bot instance
 * @param {(message: string) => void} send - called with each verified message
 * @param {string} botName - name to speak as
 * @param {{stop?: boolean}} [state] - when `state.stop` is true the loop exits
 * @param {(err: Error) => void} [onError] - called on every failed turn; the
 *   loop keeps going after a failure so a dead LLM does not stop the bot
 * @param {{getHistory?: () => string[], maxWords?: number}} [opts] - the
 *   recent-chat window handed to the model each turn, and the word limit
 *   verification enforces
 */
async function autoAIChatLoop (bot, send, botName, state = {}, onError = () => {}, opts = {}) {
  const { getHistory = () => [], maxWords = 15 } = opts
  console.log('[ai-chat] Starting Auto AI Chat loop');

  while (!state.stop) {
    const delay = randomDelay(AI_CHAT_INTERVAL_MIN_MS, AI_CHAT_INTERVAL_MAX_MS);
    console.log(`[ai-chat] Waiting ${delay / 1000}s before next AI chat...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    if (state.stop) break;

    let message
    try {
      message = await callFreeLLMChat(getHistory(), botName, { maxWords })
    } catch (err) {
      // A failed turn is not a reason to stop the bot — the LLM might be down
      // for a minute. Report it and keep the cadence going. There is no
      // canned fallback: silence beats a prerecorded line pretending to be
      // part of the conversation.
      onError(err)
      continue
    }
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
  extractQuotedContent,
  verifyChatMessage,
  buildUserPrompt,
  autoAIChatLoop,
  AI_CHAT_INTERVAL_MIN_MS,
  AI_CHAT_INTERVAL_MAX_MS,
  AI_CHAT_CONTEXT_MESSAGES
};
