'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { CronManager, parseSchedule, matches, nextCronRun } = require('../cron')

test('parseSchedule accepts 5-field cron and @every', () => {
  assert.equal(parseSchedule('0 4 * * *').type, 'cron')
  assert.equal(parseSchedule('*/15 * * * *').type, 'cron')
  assert.equal(parseSchedule('@every 60').type, 'interval')
  assert.equal(parseSchedule('@every 60').seconds, 60)
})

test('parseSchedule rejects bad schedules', () => {
  assert.throws(() => parseSchedule(''))
  assert.throws(() => parseSchedule('0 4 * *')) // 4 fields
  assert.throws(() => parseSchedule('61 * * * *')) // minute out of range
  assert.throws(() => parseSchedule('* 24 * * *')) // hour out of range
  assert.throws(() => parseSchedule('* * 32 * *')) // day-of-month out of range
  assert.throws(() => parseSchedule('* * * 13 *')) // month out of range
  assert.throws(() => parseSchedule('* * * * 8')) // day-of-week out of range
  assert.throws(() => parseSchedule('* * * * * *')) // 6 fields
  assert.throws(() => parseSchedule('@every 2')) // below minimum
  assert.throws(() => parseSchedule('@every nope'))
  assert.throws(() => parseSchedule('bogus * * * *'))
})

test('matches honors minute/hour/month fields', () => {
  const spec = parseSchedule('30 4 * 1 *') // 04:30 in January
  assert.equal(matches(spec, new Date(2026, 0, 15, 4, 30)), true)
  assert.equal(matches(spec, new Date(2026, 0, 15, 4, 31)), false)
  assert.equal(matches(spec, new Date(2026, 1, 15, 4, 30)), false) // February
  assert.equal(matches(spec, new Date(2026, 0, 15, 5, 30)), false)
})

test('matches supports steps and lists', () => {
  const every15 = parseSchedule('*/15 * * * *')
  assert.equal(matches(every15, new Date(2026, 0, 1, 0, 0)), true)
  assert.equal(matches(every15, new Date(2026, 0, 1, 0, 15)), true)
  assert.equal(matches(every15, new Date(2026, 0, 1, 0, 30)), true)
  assert.equal(matches(every15, new Date(2026, 0, 1, 0, 7)), false)
  const list = parseSchedule('5,10 0 * * *')
  assert.equal(matches(list, new Date(2026, 0, 1, 0, 5)), true)
  assert.equal(matches(list, new Date(2026, 0, 1, 0, 10)), true)
  assert.equal(matches(list, new Date(2026, 0, 1, 0, 6)), false)
})

test('day-of-week 7 means Sunday and 0-6 works', () => {
  const sun7 = parseSchedule('0 0 * * 7')
  const sun0 = parseSchedule('0 0 * * 0')
  const sunday = new Date(2026, 0, 4) // a Sunday
  const monday = new Date(2026, 0, 5)
  assert.equal(matches(sun7, sunday), true)
  assert.equal(matches(sun0, sunday), true)
  assert.equal(matches(sun7, monday), false)
  assert.equal(matches(sun0, monday), false)
})

test('both day-of-month and day-of-week use OR semantics', () => {
  const spec = parseSchedule('0 0 1 * 1') // 1st of month OR Mondays
  const firstOfMonth = new Date(2026, 1, 1) // Sunday, Feb 1 2026
  const monday = new Date(2026, 0, 5)
  const tuesday = new Date(2026, 0, 6)
  assert.equal(matches(spec, firstOfMonth), true)
  assert.equal(matches(spec, monday), true)
  assert.equal(matches(spec, tuesday), false)
})

test('nextCronRun returns the next matching minute', () => {
  const spec = parseSchedule('*/30 * * * *')
  const next = nextCronRun(spec, new Date(2026, 0, 1, 10, 7))
  assert.equal(next.getHours(), 10)
  assert.equal(next.getMinutes(), 30)
  const next2 = nextCronRun(spec, new Date(2026, 0, 1, 10, 30))
  assert.equal(next2.getMinutes(), 0)
  assert.equal(next2.getHours(), 11)
})

test('nextCronRun for interval spec', () => {
  const spec = parseSchedule('@every 90')
  const next = nextCronRun(spec, new Date(2026, 0, 1, 10, 0, 5))
  assert.equal(next.getTime() - new Date(2026, 0, 1, 10, 0, 5).getTime(), 90000)
})

test('CronManager add/remove/setEnabled/list/clear', () => {
  const m = new CronManager({ dispatch: () => 0 })
  const job = m.add('0 4 * * *', '/status')
  assert.equal(job.id, '1')
  assert.equal(job.command, '/status')
  assert.equal(m.list().length, 1)
  assert.ok(job.nextRun instanceof Date)
  assert.equal(m.setEnabled('1', false), true)
  assert.equal(m.list()[0].enabled, false)
  assert.equal(m.list()[0].nextRun, null)
  assert.equal(m.remove('1'), true)
  assert.equal(m.list().length, 0)
  assert.equal(m.remove('1'), false)
  assert.equal(m.setEnabled('1', true), false)
})

test('CronManager rejects bad input', () => {
  const m = new CronManager({ dispatch: () => 0 })
  assert.throws(() => m.add('not a schedule', '/status'))
  assert.throws(() => m.add('0 4 * * *', '   '))
})

test('CronManager fires due jobs in _tick', () => {
  const fired = []
  const m = new CronManager({ dispatch: (cmd) => fired.push(cmd), log: () => {} })
  const job = m.add('* * * * *', '/status')
  job.nextRun = new Date(Date.now() - 1000) // due now
  m._tick()
  assert.deepEqual(fired, ['/status'])
  assert.equal(job.runs, 1)
  assert.ok(job.lastRun instanceof Date)
  // next run recomputed into the future — not due again immediately
  assert.ok(job.nextRun.getTime() > Date.now())
  fired.length = 0
  m._tick()
  assert.deepEqual(fired, [])
})

test('CronManager interval jobs fire at the right cadence and never overlap', () => {
  const fired = []
  const m = new CronManager({ dispatch: (cmd) => { fired.push(cmd); return Promise.resolve() }, log: () => {} })
  const job = m.add('@every 30', '/all /status')
  assert.equal(job.nextRun.getTime() - Date.now() >= 30000, true)
  // Simulate the interval elapsing, then a tick fires it once.
  job.lastRun = new Date(Date.now() - 31000)
  job.nextRun = new Date(Date.now() - 1000)
  m._tick()
  assert.deepEqual(fired, ['/all /status'])
  // While still marked running, another tick must not double-fire.
  m._tick()
  assert.deepEqual(fired, ['/all /status'])
})

test('CronManager runNow triggers immediately and errors cleanly', () => {
  const fired = []
  const m = new CronManager({ dispatch: (cmd) => fired.push(cmd), log: () => {} })
  m.add('0 4 * * *', '/crates-all')
  const res = m.runNow('1')
  assert.equal(res.ok, true)
  assert.deepEqual(fired, ['/crates-all'])
  const bad = m.runNow('99')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /no cron job/)
})

test('CronManager runNow works on disabled jobs (test-fire) and stays disabled', () => {
  const fired = []
  const m = new CronManager({ dispatch: (cmd) => fired.push(cmd), log: () => {} })
  m.add('0 4 * * *', '/status')
  m.setEnabled('1', false)
  const res = m.runNow('1')
  assert.equal(res.ok, true)
  assert.deepEqual(fired, ['/status'])
  assert.equal(m.list()[0].enabled, false)
  assert.equal(m.list()[0].nextRun, null)
})

test('CronManager loadFromEnv parses CRON_JOB_<N> entries and logs errors', () => {
  const errors = []
  const m = new CronManager({ dispatch: () => 0, log: (msg) => errors.push(msg) })
  const env = {
    CRON_JOB_1: '@every 60|/status',
    CRON_JOB_2: '0 */2 * * *|/crates-all',
    CRON_JOB_3: 'broken schedule|/status',
    CRON_JOB_4: 'missing separator',
    CRON_JOB_5: '0 4 * * *|'
  }
  const loaded = m.loadFromEnv(env)
  assert.equal(loaded, 2)
  assert.equal(m.list().length, 2)
  assert.equal(m.list()[0].schedule, '@every 60')
  assert.equal(m.list()[1].command, '/crates-all')
  assert.equal(errors.length, 3)
})

test('dispatch errors are caught and logged', () => {
  const errors = []
  const m = new CronManager({ dispatch: () => { throw new Error('boom') }, log: (msg) => errors.push(msg) })
  const job = m.add('* * * * *', '/status')
  job.nextRun = new Date(Date.now() - 1000)
  m._tick()
  assert.equal(errors.some(e => e.includes('boom')), true)
  assert.equal(m.list()[0].running, false)
})