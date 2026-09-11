'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSchedule } = require('../scripts/pull-and-stagger-disconnect')

test('buildSchedule randomizes order while keeping disconnects spaced and bounded', () => {
  const schedule = buildSchedule(['a', 'b', 'c', 'd'], {
    minWindowMs: 4_000,
    maxWindowMs: 4_000,
    minGapMs: 500,
    random: () => 0.5
  })

  assert.equal(schedule.length, 4)
  assert.deepEqual(schedule.map(item => item.id).sort(), ['a', 'b', 'c', 'd'])
  assert.equal(schedule[0].offsetMs, 0)
  assert.ok(schedule.every(item => item.offsetMs >= 0 && item.offsetMs <= 4_000))
  for (let i = 1; i < schedule.length; i++) {
    assert.ok(schedule[i].offsetMs - schedule[i - 1].offsetMs >= 500)
  }
})

test('buildSchedule handles an empty roster', () => {
  assert.deepEqual(buildSchedule([]), [])
})
