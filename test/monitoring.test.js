'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { classifyKick, chatText, parseBanDuration } = require('../monitoring')

// Verbatim FATALMC ban screen as the bot logged it: a serialized chat component,
// not a string, with the expiry buried in a nested text leaf.
const FATALMC_BAN = fs.readFileSync(path.join(__dirname, 'fixtures', 'fatalmc-ban-kick.json'), 'utf8')

// A ban arrives as an ordinary kick packet, so the wording is the only evidence
// there is. These are the phrasings real servers use.
test('classifyKick recognises permanent, temporary, blacklist, and suspected bans', () => {
  assert.equal(classifyKick('You are permanently banned from this server!').kind, 'permanent')
  assert.equal(classifyKick('You have been banned for cheating').kind, 'permanent')
  assert.equal(classifyKick('Kicked: You have been blacklisted from the network').kind, 'blacklist')
  assert.equal(classifyKick('Kicked: alt detected, use your main account').kind, 'suspected')
  assert.equal(classifyKick('Blocked by an anti-bot filter').kind, 'suspected')
})

// A temporary ban also contains the bare word "banned", so the more specific
// pattern has to win or every tempban would look permanent.
test('a temporary ban is not reported as permanent', () => {
  const verdict = classifyKick('You are temporarily banned for 3 days from this server!')
  assert.equal(verdict.banned, true)
  assert.equal(verdict.kind, 'temporary')
  assert.equal(verdict.duration, '3 days')
})

test('a ban with an absolute expiry is temporary and carries the timestamp', () => {
  const verdict = classifyKick('Kicked: You are banned (ban expires 2026-10-01)')
  assert.equal(verdict.kind, 'temporary')
  assert.equal(verdict.permanent, false)
  assert.equal(verdict.expiresAt, Date.parse('2026-10-01'), 'an absolute date is an expiry, not a duration')
  assert.equal(verdict.durationMs, 0)
})

// ── The real ban screen ─────────────────────────────────────────────────────

// This used to be the worst case: the word "banned" matched inside the JSON tree,
// but "Expires in: 29 days, 11 hours, 17 minutes" did not, so a 29-day tempban was
// reported as permanent and the bot would have been treated as gone for good.
test('flattens a serialized chat-component ban and reads its expiry', () => {
  const verdict = classifyKick(FATALMC_BAN)
  assert.equal(verdict.banned, true)
  assert.equal(verdict.kind, 'temporary')
  assert.equal(verdict.permanent, false)
  assert.equal(verdict.duration, '29 days, 11 hours, 17 minutes')
  assert.equal(verdict.durationMs, 29 * 86400000 + 11 * 3600000 + 17 * 60000)
  assert.ok(verdict.durationMs / 86400000 > 29 && verdict.durationMs / 86400000 < 30)
})

test('the flattened ban text is readable and keeps its lines', () => {
  const verdict = classifyKick(FATALMC_BAN)
  assert.match(verdict.text, /You have been banned due to Alt Farming \(3rd\)/)
  assert.match(verdict.text, /Banned on: 16 Sep 2026, 13:34/)
  assert.match(verdict.text, /Expires in: 29 days, 11 hours, 17 minutes/)
  assert.match(verdict.text, /discord\.gg\/fatalmc/)
  assert.doesNotMatch(verdict.text, /"type":"string"/, 'the NBT wrapper is gone')
  assert.ok(verdict.text.length < 400, 'no 1.5 KB JSON blob')
})

// The reason is what lands in the spreadsheet and the Discord embed, so it has to
// be the phrase a human wrote, not the component tree.
test('a ban reason is a short phrase plus its case id', () => {
  const verdict = classifyKick(FATALMC_BAN)
  assert.equal(verdict.reason, 'Alt Farming (3rd)')
  assert.equal(verdict.caseId, '1129')
  assert.ok(verdict.reason.length < 40)
})

test('a ban screen with no expiry is treated as permanent', () => {
  for (const text of ['You are permanently banned from this server!', 'You have been banned due to cheating', 'Account suspended']) {
    const verdict = classifyKick(text)
    assert.equal(verdict.banned, true, text)
    assert.equal(verdict.permanent, true, text)
    assert.equal(verdict.kind, 'permanent', text)
    assert.equal(verdict.durationMs, 0, text)
  }
})

test('chatText walks the component shapes servers actually send', () => {
  assert.equal(chatText('plain'), 'plain')
  assert.equal(chatText({ text: 'a', extra: [{ text: 'b' }, 'c'] }), 'abc')
  assert.equal(chatText({ type: 'string', value: 'wrapped' }), 'wrapped')
  assert.equal(chatText({ type: 'compound', value: { extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'x' } }] } } } }), 'x')
  assert.equal(chatText(null), '')
  assert.equal(chatText({}), '')
})

test('parseBanDuration converts the units a server names', () => {
  assert.equal(parseBanDuration('3 days'), 3 * 86400000)
  assert.equal(parseBanDuration('1 hour, 30 minutes'), 5400000)
  assert.equal(parseBanDuration('2 weeks'), 1209600000)
  assert.equal(parseBanDuration('29 days, 11 hours, 17 minutes'), 2546220000)
  assert.equal(parseBanDuration('no numbers here'), 0)
  assert.equal(parseBanDuration(''), 0)
  assert.equal(parseBanDuration(null), 0)
})

test('ordinary kicks and disconnects are not bans', () => {
  for (const text of ['You are not whitelisted on this server!', 'Server closed', 'Server is restarting', 'socketClosed', 'Kicked: AFK too long']) {
    const verdict = classifyKick(text)
    assert.equal(verdict.banned, false, `"${text}" must not be treated as a ban`)
    assert.equal(verdict.kind, '')
    assert.equal(verdict.reason, text, 'the reason is still handed back for the log')
  }
})

test('an empty or missing reason is never a ban', () => {
  for (const value of ['', '   ', null, undefined]) {
    const verdict = classifyKick(value)
    assert.equal(verdict.banned, false)
    assert.equal(verdict.reason, '')
  }
  assert.equal(classifyKick({}).banned, false, 'an unrelated object is not a ban either')
})

// node-minecraft-protocol can hand back a chat component instead of a plain
// string, so the reason is flattened before matching.
test('a structured kick reason is flattened before matching', () => {
  assert.equal(classifyKick({ text: 'You are permanently banned', extra: [{ text: '!' }] }).banned, true)
  assert.equal(classifyKick({ text: 'You are not whitelisted' }).banned, false)
})

// BAN_MESSAGE_REGEX lets a server's own wording be added without a code change.
// The pattern is compiled at module load, so this needs a fresh module instance.
test('BAN_MESSAGE_REGEX adds a server-specific ban phrase', () => {
  const modulePath = require.resolve('../monitoring')
  const original = process.env.BAN_MESSAGE_REGEX
  try {
    process.env.BAN_MESSAGE_REGEX = 'you have been removed from the network'
    delete require.cache[modulePath]
    const fresh = require('../monitoring')
    assert.equal(fresh.classifyKick('You have been removed from the network').banned, true)
    assert.equal(fresh.classifyKick('You have been removed from the network').kind, 'permanent')
    assert.equal(fresh.classifyKick('You are banned').kind, 'permanent', 'the built-in patterns still apply')

    process.env.BAN_MESSAGE_REGEX = '(unclosed'
    delete require.cache[modulePath]
    const broken = require('../monitoring')
    assert.equal(broken.classifyKick('anything').banned, false, 'a broken pattern must not take the classifier down')
  } finally {
    if (original === undefined) delete process.env.BAN_MESSAGE_REGEX
    else process.env.BAN_MESSAGE_REGEX = original
    delete require.cache[modulePath]
    require('../monitoring')
  }
})

// ── Discord alerting ────────────────────────────────────────────────────────
// createMonitoring reads its config at construction and posts through global
// fetch, so both are stubbed here and restored afterwards.
const ENV_KEYS = ['DISCORD_WEBHOOK_URL', 'DISCORD_USER_ID', 'DISCORD_NOTIFICATIONS', 'DISCORD_BAN_COOLDOWN_MS', 'DISCORD_AUTH_COOLDOWN_MS', 'MEMORY_WATCHDOG', 'DISCORD_MENTION_CRITICAL_ONLY']

async function withMonitoring (env, fn) {
  const { createMonitoring } = require('../monitoring')
  const saved = {}
  ENV_KEYS.forEach(key => { saved[key] = process.env[key] })
  Object.assign(process.env, { MEMORY_WATCHDOG: 'false', DISCORD_WEBHOOK_URL: 'https://discord.test/webhook' }, env)
  const sent = []
  const lines = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body))
    return { ok: true, status: 204, headers: { get: () => null } }
  }
  const monitoring = createMonitoring({ logFor: (id, line) => lines.push(line), systemId: 'sys', sanitize: value => String(value) })
  try {
    await fn({ monitoring, sent, lines })
  } finally {
    monitoring.stop()
    globalThis.fetch = originalFetch
    ENV_KEYS.forEach(key => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] })
  }
}

test('a ban kick posts a ban alert instead of a plain kick', async () => {
  await withMonitoring({ DISCORD_USER_ID: '12345', DISCORD_MENTION_CRITICAL_ONLY: 'true' }, async ({ monitoring, sent, lines }) => {
    await monitoring.onKick('Hypr_7_core', 'You are permanently banned from this server!')
    assert.equal(sent.length, 1)
    const embed = sent[0].embeds[0]
    assert.equal(embed.title, 'Bot banned')
    assert.equal(embed.color, 0xdc2626)
    assert.match(embed.description, /permanently banned/)
    assert.deepEqual(embed.fields, [{ name: 'Ban type', value: 'permanent', inline: true }])
    assert.match(sent[0].content, /<@12345>/, 'a ban is critical, so the operator is mentioned')
    assert.ok(lines.some(line => /banned \(permanent\)/.test(line)), 'and it is written to the local log too')
  })
})

test('a temporary ban reports how long it lasts', async () => {
  await withMonitoring({}, async ({ monitoring, sent }) => {
    await monitoring.onKick('Hypr_7_alt', 'You are temporarily banned for 3 days from this server!')
    const embed = sent[0].embeds[0]
    assert.equal(embed.title, 'Bot temporarily banned')
    assert.deepEqual(embed.fields, [
      { name: 'Ban type', value: 'temporary', inline: true },
      { name: 'Duration', value: '3 days', inline: true }
    ])
  })
})

// A suspected ban (anti-bot / alt detection) is worth flagging but must not page
// the operator as if it were certain.
test('a suspected ban is reported without the critical mention', async () => {
  await withMonitoring({ DISCORD_USER_ID: '12345', DISCORD_MENTION_CRITICAL_ONLY: 'true' }, async ({ monitoring, sent }) => {
    await monitoring.onKick('Hypr_7_core', 'Kicked: alt detected, use your main account')
    assert.equal(sent[0].embeds[0].title, 'Possible bot ban')
    assert.equal(sent[0].content, '', 'not paged for something uncertain')
  })
})

test('a ban alert is not repeated while the same ban is still in effect', async () => {
  await withMonitoring({}, async ({ monitoring, sent }) => {
    await monitoring.onKick('Hypr_7_core', 'You are banned!')
    await monitoring.onKick('Hypr_7_core', 'You are banned!')
    assert.equal(sent.length, 1, 'reconnect attempts against the same ban must not spam Discord')
  })
})

// A rejected /login is our own credential being wrong, not the server punishing
// an account, and the bot has stopped trying — so the alert has to say what to
// edit, and must not read like one more reconnect in the feed.
test('a rejected login pages the operator once, naming the variable to fix', async () => {
  await withMonitoring({ DISCORD_USER_ID: '12345', DISCORD_MENTION_CRITICAL_ONLY: 'true' }, async ({ monitoring, sent, lines }) => {
    const failure = { kind: 'bad-password', reason: 'Wrong password', at: 1000, until: null, count: 1 }
    await monitoring.onAuthFailure('BotOne', failure)
    assert.equal(sent.length, 1)
    const embed = sent[0].embeds[0]
    assert.equal(embed.title, 'Bot login rejected')
    assert.equal(embed.color, 0xdc2626)
    assert.match(embed.description, /Wrong password/)
    assert.match(embed.description, /stopped sending/)
    assert.match(embed.description, /LOGIN_PASSWORD/)
    assert.match(embed.description, /\/auth-retry BotOne/)
    assert.deepEqual(embed.fields, [{ name: 'Failure', value: 'bad-password', inline: true }])
    assert.match(sent[0].content, /<@12345>/, 'a wrong password is critical: it cannot fix itself')
    assert.ok(lines.some(line => /auth bad-password/.test(line)), 'and it is written to the local log')

    // Reconnect attempts against the same failure must not spam the channel.
    await monitoring.onAuthFailure('BotOne', failure)
    assert.equal(sent.length, 1, 'the same failure alerts once')
  })
})

test('a throttled auth failure is amber and does not page the operator', async () => {
  await withMonitoring({ DISCORD_USER_ID: '12345', DISCORD_MENTION_CRITICAL_ONLY: 'true' }, async ({ monitoring, sent }) => {
    await monitoring.onAuthFailure('BotOne', { kind: 'throttled', reason: 'Too many failed attempts', until: Date.now() + 300000, count: 1 })
    const embed = sent[0].embeds[0]
    assert.equal(embed.title, 'Bot auth cannot proceed')
    assert.equal(embed.color, 0xf97316)
    assert.match(embed.description, /waiting before trying again/)
    assert.equal(sent[0].content, '', 'waiting is not worth a mention')
  })
})

test('an ordinary kick still uses the plain kick alert', async () => {
  await withMonitoring({ DISCORD_USER_ID: '12345', DISCORD_MENTION_CRITICAL_ONLY: 'true' }, async ({ monitoring, sent }) => {
    await monitoring.onKick('Hypr_7_core', 'Kicked: AFK too long')
    assert.equal(sent[0].embeds[0].title, 'Bot kicked')
    assert.equal(sent[0].content, '', 'a normal kick is not critical')
  })
})
