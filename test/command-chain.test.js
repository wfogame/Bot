'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseCommandChain,
  parseSleepDuration,
  executeCommandChain
} = require('../bot-controls')

test('parseCommandChain handles && sequential, ; concurrent, and mixed operators', () => {
  assert.deepEqual(parseCommandChain('/status && /inv'), [
    { command: '/status', separator: '&&' },
    { command: '/inv', separator: null }
  ])

  assert.deepEqual(parseCommandChain('/status ; /inv'), [
    { command: '/status', separator: ';' },
    { command: '/inv', separator: null }
  ])

  assert.deepEqual(parseCommandChain('/status && sleep 100ms && /inv ; /players'), [
    { command: '/status', separator: '&&' },
    { command: 'sleep 100ms', separator: '&&' },
    { command: '/inv', separator: ';' },
    { command: '/players', separator: null }
  ])

  // Leading, trailing, and redundant operators
  assert.deepEqual(parseCommandChain('/status ; '), [
    { command: '/status', separator: null }
  ])
  assert.deepEqual(parseCommandChain(' ; /status'), [
    { command: '/status', separator: null }
  ])
  assert.deepEqual(parseCommandChain('/status && && /inv'), [
    { command: '/status', separator: '&&' },
    { command: '/inv', separator: null }
  ])
  assert.deepEqual(parseCommandChain(''), [])
  assert.deepEqual(parseCommandChain('   '), [])
  assert.deepEqual(parseCommandChain(null), [])
})

test('parseCommandChain recognizes escaped operators \\&& and \\; and preserves lone \\', () => {
  // Escaped && becomes literal && within single command
  assert.deepEqual(parseCommandChain('/chat hello \\&& world'), [
    { command: '/chat hello && world', separator: null }
  ])

  // Escaped ; becomes literal ; within single command
  assert.deepEqual(parseCommandChain('/chat hello \\; world'), [
    { command: '/chat hello ; world', separator: null }
  ])

  // Lone backslashes preserved
  assert.deepEqual(parseCommandChain('\\hello \\world'), [
    { command: '\\hello \\world', separator: null }
  ])

  // Mixed escaped and unescaped operators
  assert.deepEqual(parseCommandChain('/chat literal \\&& here && /inv \\; also'), [
    { command: '/chat literal && here', separator: '&&' },
    { command: '/inv ; also', separator: null }
  ])
})

test('parseSleepDuration parses 5, 5s, 2.5s, 500ms, 5000, 1, 2s', () => {
  // Milliseconds
  assert.equal(parseSleepDuration('500ms'), 500)
  assert.equal(parseSleepDuration('50ms'), 50)
  assert.equal(parseSleepDuration('1000ms'), 1000)

  // Seconds with unit
  assert.equal(parseSleepDuration('5s'), 5000)
  assert.equal(parseSleepDuration('2.5s'), 2500)
  assert.equal(parseSleepDuration('2s'), 2000)
  assert.equal(parseSleepDuration('0.5s'), 500)

  // Plain numbers (unsuffixed)
  assert.equal(parseSleepDuration('1'), 1000)
  assert.equal(parseSleepDuration('5'), 5000)
  assert.equal(parseSleepDuration('2.5'), 2500)
  assert.equal(parseSleepDuration('5000'), 5000) // values >= 1000 treated as ms

  // Edge and invalid cases
  assert.equal(parseSleepDuration('0'), 0)
  assert.equal(parseSleepDuration('0s'), 0)
  assert.equal(parseSleepDuration('0ms'), 0)
  assert.equal(parseSleepDuration('abc'), null)
  assert.equal(parseSleepDuration('-5s'), null)
  assert.equal(parseSleepDuration(''), null)
  assert.equal(parseSleepDuration(null), null)
})

test('executeCommandChain executes sequential steps (&&) awaiting promises even on error', async () => {
  const events = []
  const chain = [
    { command: 'first', separator: '&&' },
    { command: 'errorStep', separator: '&&' },
    { command: 'third', separator: null }
  ]

  let resolveFirst
  const firstPromise = new Promise(resolve => { resolveFirst = resolve })

  const executeSingle = async (cmd) => {
    events.push(`start:${cmd}`)
    if (cmd === 'first') {
      await firstPromise
      events.push(`done:${cmd}`)
    } else if (cmd === 'errorStep') {
      events.push(`fail:${cmd}`)
      throw new Error('boom')
    } else {
      events.push(`done:${cmd}`)
    }
  }

  const chainPromise = executeCommandChain(chain, null, { executeSingle })

  // 'first' has started, but not finished yet
  assert.deepEqual(events, ['start:first'])

  // Resolve 'first' -> 'errorStep' starts, fails, and 'third' still executes
  resolveFirst()
  await chainPromise

  assert.deepEqual(events, [
    'start:first',
    'done:first',
    'start:errorStep',
    'fail:errorStep',
    'start:third',
    'done:third'
  ])
})

test('executeCommandChain executes immediate steps (;) concurrently without awaiting', async () => {
  const events = []
  const chain = [
    { command: 'slow', separator: ';' },
    { command: 'fast', separator: null }
  ]

  let resolveSlow
  const slowPromise = new Promise(resolve => { resolveSlow = resolve })

  const executeSingle = async (cmd) => {
    events.push(`start:${cmd}`)
    if (cmd === 'slow') {
      await slowPromise
      events.push(`done:${cmd}`)
    } else {
      events.push(`done:${cmd}`)
    }
  }

  const chainPromise = executeCommandChain(chain, null, { executeSingle })

  // 'fast' executes immediately without waiting for 'slow'
  await chainPromise
  assert.deepEqual(events, [
    'start:slow',
    'start:fast',
    'done:fast'
  ])

  // Clean up slow background promise
  resolveSlow()
  await slowPromise
  assert.deepEqual(events, [
    'start:slow',
    'start:fast',
    'done:fast',
    'done:slow'
  ])
})

test('executeCommandChain delays with sleep (sleep 500ms, sleep 2s, sleep 1)', async () => {
  const slept = []
  const dispatched = []
  const mockSleep = ms => {
    slept.push(ms)
    return Promise.resolve()
  }

  const chain = [
    { command: 'sleep 500ms', separator: '&&' },
    { command: 'step1', separator: '&&' },
    { command: 'sleep 2s', separator: '&&' },
    { command: 'step2', separator: '&&' },
    { command: 'sleep 1', separator: '&&' },
    { command: 'step3', separator: null }
  ]

  await executeCommandChain(chain, null, {
    executeSingle: cmd => dispatched.push(cmd),
    sleep: mockSleep
  })

  assert.deepEqual(slept, [500, 2000, 1000])
  assert.deepEqual(dispatched, ['step1', 'step2', 'step3'])
})

test('executeCommandChain preserves literal escaped operators in dispatched commands', async () => {
  const dispatched = []
  const chain = parseCommandChain('/chat hello \\&& world ; /chat test \\; literal')

  await executeCommandChain(chain, null, {
    executeSingle: cmd => dispatched.push(cmd)
  })

  assert.deepEqual(dispatched, [
    '/chat hello && world',
    '/chat test ; literal'
  ])
})
