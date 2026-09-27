'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const ai = require('../ai-chat')

function mockFetch (responses) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.data }
  }
  return { fn, calls }
}

const savedEnv = {}
function setEnv (values) {
  for (const [key, value] of Object.entries(values)) {
    savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
function restoreEnv () {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

test('extractQuotedContent prefers the whole quoted string and falls back to a span', () => {
  assert.equal(ai.extractQuotedContent('"nice loot today"'), 'nice loot today')
  assert.equal(ai.extractQuotedContent('Sure! "yeah thats bad" ok'), 'yeah thats bad')
  assert.equal(ai.extractQuotedContent('no quotes here'), null)
  assert.equal(ai.extractQuotedContent(''), null)
  assert.equal(ai.extractQuotedContent(null), null)
})

test('verifyChatMessage gates what may reach public chat', () => {
  // Cleanup: color codes stripped, whitespace collapsed, unicode intact.
  const ok = ai.verifyChatMessage('  nice \u00a7btoday  ')
  assert.equal(ok.ok, true)
  assert.equal(ok.message, 'nice today')
  const uni = ai.verifyChatMessage('\u{1D4AE}\u{1D4FC}\u{1D4F9}\u{1D4F9}\u{1D502}')
  assert.equal(uni.ok, true)
  assert.equal(uni.message, '\u{1D4AE}\u{1D4FC}\u{1D4F9}\u{1D4F9}\u{1D502}')

  assert.equal(ai.verifyChatMessage('   ').ok, false, 'empty after cleanup')
  assert.equal(ai.verifyChatMessage(null).ok, false)
  // A message that looks like a command is the /all typo exposure — refused.
  assert.equal(ai.verifyChatMessage('/server lifesteal').ok, false)
  assert.equal(ai.verifyChatMessage('.server lifesteal').ok, false)
  assert.equal(ai.verifyChatMessage('one two three four five six', { maxWords: 5 }).ok, false, 'word limit')
  assert.equal(ai.verifyChatMessage('x'.repeat(300)).ok, false, 'length limit')
})

test('buildUserPrompt carries the last 5 chat lines, oldest first', () => {
  const prompt = ai.buildUserPrompt(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  assert.equal(prompt.includes('m1'), false, 'the oldest line falls out of the window')
  assert.match(prompt, /1\. m2/)
  assert.match(prompt, /5\. m6/)
  const quiet = ai.buildUserPrompt([])
  assert.match(quiet, /chat has been quiet/)
})

test('callFreeLLMChat passes the chat context, the configured model, and returns the verified quote', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1', AI_CHAT_MODEL: 'auto:fast' })
  try {
    const { fn, calls } = mockFetch([{ data: { choices: [{ message: { content: '"yeah thats bad"' } }] } }])
    const msg = await ai.callFreeLLMChat(['Steve: hi', 'Alex: trade?'], 'BotA', { fetchImpl: fn })
    assert.equal(msg, 'yeah thats bad')
    assert.equal(calls[0].url, 'http://llm.test/v1/chat/completions')
    assert.equal(calls[0].body.model, 'auto:fast', 'AI_CHAT_MODEL is used, not hardcoded')
    const user = calls[0].body.messages[1].content
    assert.match(user, /Steve: hi/)
    assert.match(user, /Alex: trade\?/)
  } finally {
    restoreEnv()
  }
})

test('a turn with no verifiable message is skipped, never replaced by a canned line', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    const { fn, calls } = mockFetch([
      { data: { choices: [{ message: { content: 'Sure! Here is text with no quotes at all' } }] } },
      { data: { choices: [{ message: { content: '"/server lifesteal"' } }] } },
      { data: { choices: [{ message: { content: '"one two three four five six"' } }] } }
    ])
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: fn, maxWords: 5 }),
      /no verifiable message/
    )
    assert.equal(calls.length, 3, 'every attempt was a real generation')
  } finally {
    restoreEnv()
  }
})

test('unverified and unusable attempts are retried within the same turn', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    const { fn, calls } = mockFetch([
      { data: { choices: [{ message: { content: '"one two three four five six"' } }] } },
      { data: { choices: [{ message: { content: '"ok pal"' } }] } }
    ])
    const msg = await ai.callFreeLLMChat([], 'BotA', { fetchImpl: fn, maxWords: 5 })
    assert.equal(msg, 'ok pal')
    assert.equal(calls.length, 2)
  } finally {
    restoreEnv()
  }
})

test('falls back to /responses when the server only speaks that dialect', async () => {
  setEnv({ FREE_LLM_API_KEY: 'k', FREE_LLM_BASE_URL: 'http://llm.test/v1' })
  try {
    const { fn, calls } = mockFetch([
      { ok: false, status: 404 },
      { data: { outputs: [{ text: '"ok pal"' }] } }
    ])
    const msg = await ai.callFreeLLMChat([], 'BotA', { fetchImpl: fn })
    assert.equal(msg, 'ok pal')
    assert.equal(calls[0].url.endsWith('/chat/completions'), true)
    assert.equal(calls[1].url.endsWith('/responses'), true)
  } finally {
    restoreEnv()
  }
})

test('without credentials the turn reports the configuration problem', async () => {
  setEnv({ FREE_LLM_API_KEY: undefined, FREE_LLM_BASE_URL: undefined })
  try {
    await assert.rejects(
      ai.callFreeLLMChat([], 'BotA', { fetchImpl: async () => { throw new Error('should not fetch') } }),
      /not configured/
    )
  } finally {
    restoreEnv()
  }
})
