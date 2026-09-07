'use strict'

// Node timers clamp invalid/overflowing delays to 1ms; fall back instead.
function readDelayMs(value, fallback = 15000) {
  if (value == null || String(value).trim() === '') return fallback
  const ms = Number(value)
  return Number.isSafeInteger(ms) && ms >= 1 && ms <= 2147483647 ? ms : fallback
}

function shuffledCopy(values, random = Math.random) {
  const result = values.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// One pending timer, regardless of fleet size. Starts are spaced, not completions:
// existing local routines manage their own async lifecycles and report their errors.
function createSlowBroadcast({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let running = false
  let timer = null
  let generation = 0
  return {
    get running() { return running },
    start(ids, delayMs, dispatch, { onError = () => {}, onDone = () => {} } = {}) {
      if (running) return false
      running = true
      const run = ++generation
      const targets = ids.slice()
      let index = 0, sent = 0, skipped = 0
      const next = () => {
        timer = null
        if (run !== generation) return
        if (index < targets.length) {
          const id = targets[index++]
          try {
            if (dispatch(id)) sent++
            else skipped++
          } catch (err) {
            skipped++
            onError(err, id)
          }
        }
        if (run !== generation) return
        if (index < targets.length) timer = setTimer(next, delayMs)
        else {
          running = false
          onDone({ sent, skipped })
        }
      }
      next() // first bot immediately; no unnecessary final wait
      return true
    },
    cancel() {
      generation++
      if (timer !== null) clearTimer(timer)
      timer = null
      running = false
    }
  }
}

module.exports = { readDelayMs, shuffledCopy, createSlowBroadcast }
