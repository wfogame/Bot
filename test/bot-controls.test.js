'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readDelayMs, shuffledCopy, createSlowBroadcast, parseProxyGroups, resolveBotProxy } = require('../bot-controls')

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
    { index: 1, bots: ['Alice', 'Bob'], host: '1.2.3.4', port: 1081, type: 'http' },
    { index: 2, bots: ['Carol'], host: '5.6.7.8', port: 1080, type: 'socks5' }
  ])
})

test('parseProxyGroups skips a group missing bots or host', () => {
  const env = { PROXY_GROUP_1_BOTS: '', PROXY_GROUP_1_HOST: '1.2.3.4' }
  assert.deepEqual(parseProxyGroups(env), [])
  assert.deepEqual(parseProxyGroups({}), [])
})

test('resolveBotProxy matches the group containing the bot', () => {
  const groups = parseProxyGroups({
    PROXY_GROUP_1_BOTS: 'Alice,Bob', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_PORT: '1081', PROXY_GROUP_1_TYPE: 'http',
    PROXY_GROUP_2_BOTS: 'Carol', PROXY_GROUP_2_HOST: '5.6.7.8'
  })
  assert.deepEqual(resolveBotProxy('Bob', groups), { host: '1.2.3.4', port: 1081, type: 'http', group: 1 })
  assert.deepEqual(resolveBotProxy('Carol', groups), { host: '5.6.7.8', port: 1080, type: 'socks5', group: 2 })
})

test('resolveBotProxy falls back when unmatched, disabled, or empty', () => {
  const groups = parseProxyGroups({ PROXY_GROUP_1_BOTS: 'Alice', PROXY_GROUP_1_HOST: '1.2.3.4' })
  const fallback = { host: 'global-host', port: 1080, type: 'socks5' }
  assert.deepEqual(resolveBotProxy('Zed', groups, fallback), fallback)
  assert.equal(resolveBotProxy('Zed', groups, null), null)
  assert.equal(resolveBotProxy('Alice', [], fallback), fallback)
  assert.equal(resolveBotProxy('Alice', undefined, fallback), fallback)
})
