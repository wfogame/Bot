'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readDelayMs, readInt, readNumber, parseDumpMode, parseDataArgs, parseCratesAllDump, parseCratesAllAfk, parseCratesAllFlags, shuffledCopy, createSlowBroadcast, createSlowBroadcastManager, parseProxyGroups, resolveBotProxy, hasProxyAuth, proxyAuthHeader, buildHttpConnectRequest, describeProxy, resolveLoginPassword, parseBotPasswords, classifyAuthReply, nextAuthFailure, isAuthBlocked, findIgnoredProxyGroupVars } = require('../bot-controls')

function clock() {
  let time = 0, sequence = 0
  const timers = new Map()
  return {
    timers,
    get time() { return time },
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, due: time + delay }); return id },
    clearTimer(id) { timers.delete(id) },
    tick(ms) {
      const end = time + ms
      while (true) {
        const due = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
        if (!due || due[1].due > end) break
        time = due[1].due; timers.delete(due[0]); due[1].fn()
      }
      time = end
    }
  }
}

test('readInt and readNumber fall back on missing, junk, or out-of-range values', () => {
  assert.equal(readInt(undefined, 50), 50)
  assert.equal(readInt('', 50), 50)
  assert.equal(readInt('500', 50), 500)
  assert.equal(readInt('0', 50, 1, 500), 50)
  assert.equal(readInt('501', 50, 1, 500), 50)
  assert.equal(readInt('12.4', 50), 12)
  assert.equal(readInt('junk', 50), 50)
  assert.equal(readNumber('30', 30, 1, 256), 30)
  assert.equal(readNumber('3.5', 10, 0.5, 1000), 3.5)
  assert.equal(readNumber('0.1', 10, 0.5, 1000), 10)
  assert.equal(readNumber('nope', 10, 0.5, 1000), 10)
})

test('parseDumpMode flags a typo instead of silently starting a TPA dump', () => {
  assert.deepEqual(parseDumpMode(undefined), { mode: 'tpa', unknown: null })
  assert.deepEqual(parseDumpMode(''), { mode: 'tpa', unknown: null })
  assert.deepEqual(parseDumpMode('HOME'), { mode: 'home', unknown: null })
  assert.deepEqual(parseDumpMode('hidden'), { mode: 'hidden', unknown: null })
  assert.deepEqual(parseDumpMode('cancel'), { mode: 'cancel', unknown: null })
  assert.deepEqual(parseDumpMode('hiden'), { mode: 'tpa', unknown: 'hiden' })
})

test('crates-all dump= picks the dump step, and a bare value is a TPA target', () => {
  assert.equal(parseCratesAllDump(undefined).dump, 'tpa')
  assert.equal(parseCratesAllDump('').dump, 'tpa')
  assert.equal(parseCratesAllDump('OFF').dump, 'off')
  assert.equal(parseCratesAllDump('none').dump, 'off')
  assert.equal(parseCratesAllDump('HOME').dump, 'home')
  assert.equal(parseCratesAllDump('hidden').dump, 'hidden')
  // A target must be spelled out: `dump=Smith` is a typo, not a player name, so
  // it is reported instead of teleporting the bot to a player called "Smith".
  assert.deepEqual(parseCratesAllDump('player:Smith'), { dump: 'tpa', target: 'Smith', unknown: null })
  assert.deepEqual(parseCratesAllDump('Smith'), { dump: 'tpa', target: null, unknown: 'Smith' })
  assert.deepEqual(parseCratesAllDump('hmeo'), { dump: 'tpa', target: null, unknown: 'hmeo' })
  assert.equal(parseCratesAllDump('player:Jt_2').target, 'Jt_2')
  // A target that is missing entirely is reported, not run against an empty name.
  assert.equal(parseCratesAllDump('player:').unknown, 'player:')
})

test('crates-all afk= understands now/off/seconds and rejects the rest', () => {
  assert.deepEqual(parseCratesAllAfk('now'), { warp: true, delayMs: 0, unknown: null })
  assert.deepEqual(parseCratesAllAfk('0'), { warp: true, delayMs: 0, unknown: null })
  assert.deepEqual(parseCratesAllAfk('off'), { warp: false, delayMs: null, unknown: null })
  assert.deepEqual(parseCratesAllAfk('false'), { warp: false, delayMs: null, unknown: null })
  assert.equal(parseCratesAllAfk('30').delayMs, 30000) // a bare number means seconds
  assert.equal(parseCratesAllAfk('90s').delayMs, 90000)
  assert.equal(parseCratesAllAfk('1500ms').delayMs, 1500)
  assert.equal(parseCratesAllAfk('-5').unknown, '-5')
  assert.equal(parseCratesAllAfk('soon').unknown, 'soon')
  // Larger than a setTimeout can hold: rejected rather than clamped to 1ms.
  assert.equal(parseCratesAllAfk('999999999999').unknown, '999999999999')
})

test('crates-all flags leave unset options null and report unreadable tokens', () => {
  // Null means "not specified here" so the caller can fall back to .env.
  assert.deepEqual(parseCratesAllFlags([]), { dump: null, dumpTarget: null, afkWarp: null, afkDelayMs: null, unknown: [] })
  assert.deepEqual(parseCratesAllFlags(['dump=off', 'afk=now']), { dump: 'off', dumpTarget: null, afkWarp: true, afkDelayMs: 0, unknown: [] })
  assert.deepEqual(parseCratesAllFlags(['DUMP=player:Smith', 'AFK=30000ms']), { dump: 'tpa', dumpTarget: 'Smith', afkWarp: true, afkDelayMs: 30000, unknown: [] })
  // A typo must be reported, never silently treated as a player name or a delay.
  assert.deepEqual(parseCratesAllFlags(['dump=', 'afk=', 'foo=1', 'dump', '=off']).unknown, ['dump=', 'afk=', 'foo=1', 'dump', '=off'])
  // A bare player name is a typo, never a silent teleport target.
  assert.deepEqual(parseCratesAllFlags(['dump=Smith']).unknown, ['dump=Smith'])
})

test('delay defaults and validation never let Node clamp invalid values to 1ms', () => {
  for (const value of [undefined, '', ' ', 'NaN', 'Infinity', '-1', '0', '1.5', '15000junk', '2147483648']) assert.equal(readDelayMs(value), 15000)
  assert.equal(readDelayMs('2000'), 2000)
  assert.equal(readDelayMs(' 15000 '), 15000)
  assert.equal(readDelayMs('2147483647'), 2147483647)
})

test('Fisher-Yates shuffles a copy and preserves each input', () => {
  const input = ['A', 'B', 'C', 'D']
  const output = shuffledCopy(input, () => 0)
  assert.deepEqual(output, ['B', 'C', 'D', 'A'])
  assert.deepEqual(input, ['A', 'B', 'C', 'D'])
  assert.deepEqual([...output].sort(), input)
  assert.deepEqual(shuffledCopy([]), [])
  assert.deepEqual(shuffledCopy(['A']), ['A'])
})

test('slow broadcast starts immediately, spaces dispatches, and uses one timer', () => {
  const c = clock(), calls = [], done = []
  const job = createSlowBroadcast(c)
  job.start(['A', 'B', 'C'], 15000, id => { calls.push([id, c.time]); return true }, { onDone: r => done.push(r) })
  assert.deepEqual(calls, [['A', 0]])
  assert.equal(c.timers.size, 1)
  assert.equal(job.start(['D'], 15000, () => true), false)
  c.tick(14999); assert.equal(calls.length, 1)
  c.tick(1); assert.deepEqual(calls[1], ['B', 15000])
  assert.equal(c.timers.size, 1)
  c.tick(15000); assert.deepEqual(calls[2], ['C', 30000])
  assert.equal(c.timers.size, 0)
  assert.equal(job.running, false)
  assert.deepEqual(done, [{ sent: 3, skipped: 0 }])
})

test('custom delay, skips, failures, snapshot isolation and cancellation', () => {
  const c = clock(), ids = ['A', 'B', 'C', 'D'], seen = [], errors = [], done = []
  const job = createSlowBroadcast(c)
  job.start(ids, 25, id => {
    seen.push(id)
    if (id === 'B') return false
    if (id === 'C') throw Error('offline')
    return true
  }, { onError: (err, id) => errors.push(id), onDone: r => done.push(r) })
  ids.push('E'); c.tick(75)
  assert.deepEqual(seen, ['A', 'B', 'C', 'D'])
  assert.deepEqual(errors, ['C'])
  assert.deepEqual(done, [{ sent: 2, skipped: 2 }])
  job.start(['E', 'F'], 25, id => { seen.push(id); return true })
  job.cancel(); c.tick(100)
  assert.equal(seen.at(-1), 'E')
  assert.equal(job.running, false)
  assert.equal(c.timers.size, 0)
})

test('empty broadcast finishes without a timer', () => {
  const c = clock(), job = createSlowBroadcast(c)
  let result
  job.start([], 15000, () => assert.fail(), { onDone: r => { result = r } })
  assert.deepEqual(result, { sent: 0, skipped: 0 })
  assert.equal(job.running, false)
  assert.equal(c.timers.size, 0)
})

test('parseProxyGroups reads indexed PROXY_GROUP_N_* vars and stops at the first gap', () => {
  const env = {
    PROXY_GROUP_1_BOTS: 'Alice, Bob',
    PROXY_GROUP_1_HOST: '1.2.3.4',
    PROXY_GROUP_1_PORT: '1081',
    PROXY_GROUP_1_TYPE: 'http',
    PROXY_GROUP_2_BOTS: 'Carol',
    PROXY_GROUP_2_HOST: '5.6.7.8',
    // no PORT/TYPE -> defaults
    PROXY_GROUP_4_BOTS: 'Dave', // gap at 3 -> never reached
    PROXY_GROUP_4_HOST: '9.9.9.9'
  }
  const groups = parseProxyGroups(env)
  assert.deepEqual(groups, [
    { index: 1, bots: ['Alice', 'Bob'], host: '1.2.3.4', port: 1081, type: 'http', user: '', pass: '', loginPassword: '' },
    { index: 2, bots: ['Carol'], host: '5.6.7.8', port: 1080, type: 'socks5', user: '', pass: '', loginPassword: '' }
  ])
})

test('parseProxyGroups skips a group with no bots', () => {
  const env = { PROXY_GROUP_1_BOTS: '', PROXY_GROUP_1_HOST: '1.2.3.4' }
  assert.deepEqual(parseProxyGroups(env), [])
  assert.deepEqual(parseProxyGroups({}), [])
})

test('a group with bots but no HOST still exists, so its login password applies', () => {
  // This is the shape that used to be dropped in silence: a group used only to
  // separate accounts, carrying its own /login password and no proxy of its own.
  const env = { PROXY_GROUP_1_BOTS: 'BotA,BotB', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw' }
  const groups = parseProxyGroups(env)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].host, '', 'no dedicated proxy')
  assert.equal(groups[0].loginPassword, 'group-pw')
  assert.deepEqual(resolveLoginPassword('BotA', groups, env), { password: 'group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD' })
  // …and the bots use the default route rather than a made-up host:port.
  const fallback = { host: 'default-host', port: 1080, type: 'socks5' }
  assert.deepEqual(resolveBotProxy('BotA', groups, fallback), fallback)
  assert.equal(resolveBotProxy('BotA', groups, null), null)
})

test('a group numbered above a gap is never reached, which is why it is reported', () => {
  // The scan stops at the first missing PROXY_GROUP_<N>_BOTS: this config declares
  // group 2 only, so nothing is parsed and its password is dead weight.
  const env = { PROXY_GROUP_2_BOTS: 'BotA', PROXY_GROUP_2_LOGIN_PASSWORD: 'group-pw' }
  assert.deepEqual(parseProxyGroups(env), [])
  assert.deepEqual(findIgnoredProxyGroupVars(env, []), ['PROXY_GROUP_2_BOTS', 'PROXY_GROUP_2_LOGIN_PASSWORD'])
  // Declaring group 1 as well is what makes group 2 reachable.
  const fixed = { PROXY_GROUP_1_BOTS: 'BotZ', PROXY_GROUP_1_HOST: 'h', ...env }
  assert.equal(parseProxyGroups(fixed).length, 2)
})

test('findIgnoredProxyGroupVars names every group variable that belongs to no group', () => {
  const env = {
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h',
    // 2 is missing entirely, so 3 is never reached by the scan
    PROXY_GROUP_3_BOTS: 'B', PROXY_GROUP_3_HOST: 'h2', PROXY_GROUP_3_LOGIN_PASSWORD: 'pw',
    PROXY_HOST: 'not-a-group', PROXY_GROUPS: 'not-a-group-either'
  }
  const groups = parseProxyGroups(env)
  assert.equal(groups.length, 1)
  assert.deepEqual(findIgnoredProxyGroupVars(env, groups), ['PROXY_GROUP_3_BOTS', 'PROXY_GROUP_3_HOST', 'PROXY_GROUP_3_LOGIN_PASSWORD'])
  // A fully parsed set is reported as nothing ignored.
  assert.deepEqual(findIgnoredProxyGroupVars(env, [{ index: 1 }, { index: 3 }]), [])
  assert.deepEqual(findIgnoredProxyGroupVars({}, []), [])
})

test('resolveBotProxy matches the group containing the bot', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice,Bob', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_PORT: '1081', PROXY_GROUP_1_TYPE: 'http',
    PROXY_GROUP_2_BOTS: 'Carol', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  assert.deepEqual(resolveBotProxy('Bob', groups), { host: '1.2.3.4', port: 1081, type: 'http', user: '', pass: '', group: 1 })
  assert.deepEqual(resolveBotProxy('Carol', groups), { host: '5.6.7.8', port: 1080, type: 'socks5', user: '', pass: '', group: 2 })
})

test('resolveBotProxy falls back when unmatched, disabled, or empty', () => {
  const groups = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4' })
  const fallback = { host: 'global-host', port: 1080, type: 'socks5' }
  assert.deepEqual(resolveBotProxy('Zed', groups, fallback), fallback)
  assert.equal(resolveBotProxy('Zed', groups, null), null)
  assert.equal(resolveBotProxy('Alice', [], fallback), fallback)
  assert.equal(resolveBotProxy('Alice', undefined, fallback), fallback)
})

test('parseProxyGroups gives each group its own credentials', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_USER: 'alice', PROXY_GROUP_1_PASS: 'group-one-secret',
    PROXY_GROUP_2_BOTS: 'Bob', PROXY_GROUP_2_HOST: '5.6.7.8', PROXY_GROUP_2_PASS: 'password-only'
  })
  assert.deepEqual(groups[0], { index: 1, bots: ['Alice'], host: '1.2.3.4', port: 1080, type: 'socks5', user: 'alice', pass: 'group-one-secret', loginPassword: '' })
  // A username-less group is legal — some SOCKS5 setups authenticate on the password alone.
  assert.deepEqual(groups[1], { index: 2, bots: ['Bob'], host: '5.6.7.8', port: 1080, type: 'socks5', user: '', pass: 'password-only', loginPassword: '' })
})

test('parseProxyGroups accepts _PASSWORD as a spelling of _PASS, and _PASS wins when both are set', () => {
  const alias = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_PASSWORD: 'via-alias' })
  assert.equal(alias[0].pass, 'via-alias')
  const both = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_PASS: 'primary', PROXY_GROUP_1_PASSWORD: 'alias' })
  assert.equal(both[0].pass, 'primary')
  // An explicitly empty _PASS is a real value: it must not fall through to the alias.
  const empty = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_PASS: '', PROXY_GROUP_1_PASSWORD: 'alias' })
  assert.equal(empty[0].pass, '')
})

test('resolveBotProxy carries the matched group credentials and defaults them to empty', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_USER: 'u1', PROXY_GROUP_1_PASS: 'p1',
    PROXY_GROUP_2_BOTS: 'Bob', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  assert.deepEqual(resolveBotProxy('Alice', groups), { host: '1.2.3.4', port: 1080, type: 'socks5', user: 'u1', pass: 'p1', group: 1 })
  assert.deepEqual(resolveBotProxy('Bob', groups), { host: '5.6.7.8', port: 1080, type: 'socks5', user: '', pass: '', group: 2 })
  // A group never inherits the global password — credentials belong to a target.
  const globalFallback = { host: 'global', port: 1080, type: 'socks5', user: 'globaluser', pass: 'globalsecret' }
  assert.deepEqual(resolveBotProxy('Bob', groups).pass, '')
  assert.deepEqual(resolveBotProxy('Zed', groups, globalFallback), globalFallback)
})

test('proxyAuthHeader builds HTTP Basic auth only when credentials exist', () => {
  assert.equal(proxyAuthHeader(null), '')
  assert.equal(proxyAuthHeader({ host: 'h', port: 1 }), '')
  assert.equal(proxyAuthHeader({ host: 'h', port: 1, user: '', pass: '' }), '')
  assert.equal(proxyAuthHeader({ user: 'alice', pass: 's3cret' }), 'Basic ' + Buffer.from('alice:s3cret').toString('base64'))
  // Password-only still encodes the empty username rather than omitting the header.
  assert.equal(proxyAuthHeader({ pass: 'only' }), 'Basic ' + Buffer.from(':only').toString('base64'))
  // Non-ASCII credentials must survive the round trip as utf8, not latin1.
  const utf8 = proxyAuthHeader({ user: 'Bjorn', pass: 'pässwörd' })
  assert.equal(Buffer.from(utf8.slice('Basic '.length), 'base64').toString('utf8'), 'Bjorn:pässwörd')
})

test('buildHttpConnectRequest sends the auth header only when credentialed, and always ends with a blank line', () => {
  const plain = buildHttpConnectRequest('mc.example.com', 25565, { host: 'p', port: 8080, type: 'http' })
  assert.equal(plain, 'CONNECT mc.example.com:25565 HTTP/1.1\r\nHost: mc.example.com:25565\r\nConnection: keep-alive\r\n\r\n')
  assert.ok(!/Proxy-Authorization/i.test(plain), 'no empty auth header — some proxies answer 407 for one')

  const authed = buildHttpConnectRequest('mc.example.com', 25565, { host: 'p', port: 8080, type: 'http', user: 'alice', pass: 's3cret' })
  const expected = 'Basic ' + Buffer.from('alice:s3cret').toString('base64')
  assert.ok(authed.includes(`Proxy-Authorization: ${expected}\r\n`))
  assert.ok(authed.endsWith('Connection: keep-alive\r\n\r\n'))
  // The header must land before the terminating blank line, or the proxy reads it as the body.
  assert.ok(authed.indexOf('Proxy-Authorization') < authed.indexOf('\r\n\r\n'))
})

test('describeProxy shows the target and username but never the password', () => {
  assert.equal(describeProxy(null), 'direct (no proxy)')
  assert.equal(describeProxy({ host: '1.2.3.4', port: 1080, type: 'socks5' }), 'SOCKS5 1.2.3.4:1080')
  assert.equal(describeProxy({ host: '1.2.3.4', port: 8080, type: 'http', user: 'alice', pass: 'hunter2' }), 'HTTP alice@1.2.3.4:8080')
  // Password-only: no username to show, but the URL must not silently look credential-free.
  assert.equal(describeProxy({ host: '1.2.3.4', port: 1080, type: 'socks5', pass: 'hunter2' }), 'SOCKS5 ***@1.2.3.4:1080')
  const rendered = describeProxy({ host: 'h', port: 1, type: 'http', user: 'alice', pass: 'hunter2' })
  assert.ok(!rendered.includes('hunter2'), 'the password must never appear in a log line')
})

test('hasProxyAuth is true for a username or a password, false otherwise', () => {
  assert.equal(hasProxyAuth(null), false)
  assert.equal(hasProxyAuth({}), false)
  assert.equal(hasProxyAuth({ user: '', pass: '' }), false)
  assert.equal(hasProxyAuth({ user: 'u' }), true)
  assert.equal(hasProxyAuth({ pass: 'p' }), true)
})

test('parseProxyGroups reads the per-group Minecraft account password', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice,Bob', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-one-account-pw',
    PROXY_GROUP_2_BOTS: 'Carol', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  assert.equal(groups[0].loginPassword, 'group-one-account-pw')
  assert.equal(groups[1].loginPassword, '')
  // It is the ACCOUNT password, so it must not be confused with the proxy login.
  assert.equal(groups[0].user, '')
  assert.equal(groups[0].pass, '')
})

test('the account password is not trimmed or otherwise rewritten', () => {
  // Trimming would silently change a password that legitimately has a space and
  // lock the account out of its own /login.
  const groups = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_LOGIN_PASSWORD: ' pw with spaces ' })
  assert.equal(groups[0].loginPassword, ' pw with spaces ')
})

test('resolveLoginPassword prefers the group, then LOGIN_PASSWORD, then the built-in default', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice,Bob', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw',
    PROXY_GROUP_2_BOTS: 'Carol', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  const env = { LOGIN_PASSWORD: 'global-pw' }

  assert.deepEqual(resolveLoginPassword('Alice', groups, env), { password: 'group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD' })
  // A group that sets no account password falls back to the global one…
  assert.deepEqual(resolveLoginPassword('Carol', groups, env), { password: 'global-pw', source: 'LOGIN_PASSWORD' })
  // …and so does a bot in no group at all.
  assert.deepEqual(resolveLoginPassword('Zed', groups, env), { password: 'global-pw', source: 'LOGIN_PASSWORD' })
  // No groups configured and no env: the long-standing default, unchanged.
  assert.deepEqual(resolveLoginPassword('Alice', [], {}), { password: '123456', source: 'built-in default' })
  assert.deepEqual(resolveLoginPassword('Alice', undefined, {}), { password: '123456', source: 'built-in default' })
  // An empty LOGIN_PASSWORD means unset, not "empty password".
  assert.deepEqual(resolveLoginPassword('Alice', [], { LOGIN_PASSWORD: '' }), { password: '123456', source: 'built-in default' })
})

test('resolveLoginPassword never returns the proxy password as an account password', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4',
    PROXY_GROUP_1_USER: 'proxy-user', PROXY_GROUP_1_PASS: 'proxy-secret'
  })
  const result = resolveLoginPassword('Alice', groups, { LOGIN_PASSWORD: 'global-pw' })
  assert.equal(result.password, 'global-pw')
  assert.notEqual(result.password, 'proxy-secret')
})

test('parseBotPasswords reads both spellings, first colon splits, no trimming', () => {
  const map = parseBotPasswords({
    BOT_PASSWORDS: 'BotOne:secret-one , BotTwo:has:colons,BotThree:spaces kept ,broken,',
    BOT_PASSWORD_BotFour: 'has,comma'
  })
  // The password after the colon survives byte for byte, including a trailing
  // space: silently trimming it would turn a correct credential into a server
  // "wrong password" that cannot be reproduced by typing it.
  assert.deepEqual(map.get('botone'), { bot: 'BotOne', password: 'secret-one ', source: 'BOT_PASSWORDS' })
  // Only the first colon separates: a password may contain colons.
  assert.equal(map.get('bottwo').password, 'has:colons')
  // The space BEFORE a name is separator formatting and is dropped; the one
  // inside the password is not.
  assert.equal(map.get('botthree').password, 'spaces kept ')
  // An entry with no ':' and an empty entry are both skipped, not fatal.
  assert.equal(map.size, 4)
  assert.equal(map.get('botfour').password, 'has,comma')
  assert.equal(map.get('botfour').source, 'BOT_PASSWORD_BotFour')
})

test('the per-name variable wins over the BOT_PASSWORDS list, and lookup is case-insensitive', () => {
  const map = parseBotPasswords({ BOT_PASSWORDS: 'BotOne:from-list', BOT_PASSWORD_BotOne: 'from-name' })
  assert.equal(map.get('botone').password, 'from-name')
  assert.equal(map.get('botone').source, 'BOT_PASSWORD_BotOne')
  // Whatever the casing in .env or in BOT_NAMES, one entry is found: the map is
  // keyed lowercase and resolveLoginPassword lowercases the bot name to look it
  // up, so BOT_PASSWORD_botone serves bot BotOne instead of silently missing and
  // falling through to a different password (which reads as "wrong password").
  assert.equal(parseBotPasswords({ BOT_PASSWORD_botone: 'x' }).get('botone').password, 'x')
  assert.equal(parseBotPasswords({ BOT_PASSWORDS: 'BOTONE:x' }).get('botone').password, 'x')
  assert.equal(parseBotPasswords({}).size, 0)
  assert.equal(parseBotPasswords({ BOT_PASSWORDS: '' }).size, 0)
})

test('resolveLoginPassword puts a per-bot password above the group and the global', () => {
  const env = { LOGIN_PASSWORD: 'global-pw', BOT_PASSWORDS: 'BotTwo:own-pw,BotFour:also-own' }
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'BotOne,BotTwo,BotThree', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw'
  })
  assert.deepEqual(resolveLoginPassword('BotTwo', groups, env), { password: 'own-pw', source: 'BOT_PASSWORDS' })
  assert.deepEqual(resolveLoginPassword('BotOne', groups, env), { password: 'group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD' })
  assert.deepEqual(resolveLoginPassword('BotThree', groups, env), { password: 'group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD' })
  assert.deepEqual(resolveLoginPassword('BotFour', groups, env), { password: 'also-own', source: 'BOT_PASSWORDS' })
  assert.deepEqual(resolveLoginPassword('Stranger', groups, env), { password: 'global-pw', source: 'LOGIN_PASSWORD' })
})

test('classifyAuthReply recognises the real failure wordings and nothing else', () => {
  const bad = ['Wrong password!', 'Incorrect password', 'Invalid password', 'Password does not match', 'Passwords do not match', 'Authentication failed', 'Login failed', 'That password is not correct', 'Your password is too short']
  for (const text of bad) assert.equal(classifyAuthReply(text).kind, 'bad-password', text)

  assert.equal(classifyAuthReply('Too many failed attempts, please wait').kind, 'throttled')
  assert.equal(classifyAuthReply('Please wait 30 seconds before trying again').kind, 'throttled')
  assert.equal(classifyAuthReply('You have been temporarily blocked from logging in').kind, 'throttled')
  assert.equal(classifyAuthReply('Try again later').kind, 'throttled')

  // An existing session is not a credential verdict: the previous connection may
  // simply not have expired yet, which is normal on a fast reconnect.
  assert.equal(classifyAuthReply('You are already logged in!').kind, 'already')
  assert.equal(classifyAuthReply('This name is already registered').kind, 'already')

  for (const text of ['Welcome to the server', 'Please login using /login <password>', 'Type /register to create an account', '', 'Built by Notch']) {
    assert.equal(classifyAuthReply(text), null, text)
  }
})

test('classifyAuthReply reports the matched phrase, and prefers the specific pattern', () => {
  assert.equal(classifyAuthReply('Wrong password! Try again later.').reason, 'Wrong password')
  assert.equal(classifyAuthReply('Too many failed attempts, please wait 10 seconds before trying again').kind, 'throttled')
})

test('nextAuthFailure makes a wrong password sticky and escalates repeated throttling', () => {
  const bad = nextAuthFailure(null, { kind: 'bad-password', reason: 'Wrong password' }, 1000)
  assert.deepEqual(bad, { kind: 'bad-password', reason: 'Wrong password', at: 1000, until: null, count: 1 })

  // Throttled is tolerated twice, then treated as a wrong password so that no
  // amount of "try again later" becomes an endless retry loop.
  const first = nextAuthFailure(null, { kind: 'throttled', reason: 'Too many attempts' }, 1000, { throttleMs: 5000, maxThrottled: 2 })
  assert.equal(first.kind, 'throttled')
  assert.equal(first.until, 6000)
  const second = nextAuthFailure(first, { kind: 'throttled', reason: 'Too many attempts' }, 7000, { throttleMs: 5000, maxThrottled: 2 })
  assert.equal(second.kind, 'throttled')
  assert.equal(second.until, 12000)
  const third = nextAuthFailure(second, { kind: 'throttled', reason: 'Too many attempts' }, 13000, { throttleMs: 5000, maxThrottled: 2 })
  assert.equal(third.kind, 'bad-password')
  assert.equal(third.until, null)
  assert.match(third.reason, /repeated 3 times/)
})

test('nextAuthFailure only pauses on "already", and isAuthBlocked honours the deadline', () => {
  const already = nextAuthFailure(null, { kind: 'already', reason: 'already logged in' }, 1000, { alreadyMs: 60000 })
  assert.equal(already.kind, 'already')
  assert.equal(already.until, 61000)
  assert.equal(isAuthBlocked(already, 1000), true)
  assert.equal(isAuthBlocked(already, 60999), true)
  assert.equal(isAuthBlocked(already, 61000), false)

  const sticky = { kind: 'bad-password', until: null }
  assert.equal(isAuthBlocked(sticky, 1), true)
  assert.equal(isAuthBlocked(sticky, Number.MAX_SAFE_INTEGER), true)
  assert.equal(isAuthBlocked(null, 1), false)
})

test('multi-task createSlowBroadcastManager: concurrent tasks, independent timers, selective cancellation, and cancelAll', () => {
  const c = clock()
  const manager = createSlowBroadcastManager(c)
  assert.equal(manager.running, false)
  assert.deepEqual(manager.list(), [])

  const dispatches1 = []
  const done1 = []
  const id1 = manager.start(['A', 'B', 'C'], 10, botId => {
    dispatches1.push([botId, c.time])
    return true
  }, { command: 'first', onDone: r => done1.push(r) })

  assert.equal(id1, 1)
  assert.equal(manager.running, true)
  assert.deepEqual(dispatches1, [['A', 0]])

  const dispatches2 = []
  const done2 = []
  const id2 = manager.start(['X', 'Y'], 25, botId => {
    dispatches2.push([botId, c.time])
    return true
  }, { command: 'second', onDone: r => done2.push(r) })

  assert.equal(id2, 2)
  assert.deepEqual(dispatches2, [['X', 0]])
  assert.equal(c.timers.size, 2)

  const list = manager.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 1)
  assert.equal(list[0].command, 'first')
  assert.equal(list[1].id, 2)
  assert.equal(list[1].command, 'second')

  // Advance 10ms: task 1 dispatches B
  c.tick(10)
  assert.deepEqual(dispatches1, [['A', 0], ['B', 10]])
  assert.deepEqual(dispatches2, [['X', 0]])

  // Cancel task 1 selectively
  assert.equal(manager.cancel(id1), true)
  assert.equal(manager.cancel(999), false)
  assert.equal(manager.running, true)

  // Advance 15ms more (c.time = 25): task 2 dispatches Y and finishes
  c.tick(15)
  assert.deepEqual(dispatches2, [['X', 0], ['Y', 25]])
  assert.deepEqual(done2, [{ taskId: 2, sent: 2, skipped: 0 }])
  assert.equal(done1.length, 0) // task 1 was cancelled
  assert.equal(manager.running, false)
  assert.equal(c.timers.size, 0)

  // Test cancelAll
  const id3 = manager.start(['M', 'N'], 50, () => true)
  const id4 = manager.start(['P', 'Q'], 50, () => true)
  assert.equal(manager.running, true)
  assert.equal(manager.cancelAll(), 2)
  assert.equal(manager.running, false)
  assert.equal(c.timers.size, 0)
})

test('parseDataArgs defaults to push and reads subcommands', () => {
  assert.deepEqual(parseDataArgs(''), { action: 'push', unknown: null })
  assert.deepEqual(parseDataArgs(undefined), { action: 'push', unknown: null })
  assert.deepEqual(parseDataArgs('   '), { action: 'push', unknown: null })
  assert.deepEqual(parseDataArgs(' check '), { action: 'check', unknown: null })
  assert.deepEqual(parseDataArgs('CHECK'), { action: 'check', unknown: null })
  assert.deepEqual(parseDataArgs('doctor'), { action: 'check', unknown: null })
  assert.deepEqual(parseDataArgs('status'), { action: 'status', unknown: null })
})

// A typo must never silently start a real push without saying so.
test('parseDataArgs reports an unknown option but still pushes', () => {
  assert.deepEqual(parseDataArgs('chekc'), { action: 'push', unknown: 'chekc' })
  assert.deepEqual(parseDataArgs('pussh now'), { action: 'push', unknown: 'pussh' })
  assert.deepEqual(parseDataArgs('CHECK extra'), { action: 'check', unknown: null })
})
