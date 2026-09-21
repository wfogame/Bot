'use strict'
// The client build is what makes /play work outside Docker (the image bakes
// web-client/dist in; `npm run start` has to produce it). These tests drive
// startBuild against real throwaway shell scripts, so the process spawning,
// output tailing, and exit-code handling are covered without touching the real
// (multi-minute, multi-GB) upstream build.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const wc = require('../web-client')

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wc-build-'))
}

// Writes an executable stand-in for scripts/build-web-client.sh and returns the
// dir the module should serve from.
function fakeScript (dir, body) {
  const script = path.join(dir, 'build.sh')
  fs.writeFileSync(script, '#!/bin/sh\n' + body + '\n')
  return script
}

function waitFor (predicate, timeoutMs = 15000, intervalMs = 25) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value
      try { value = predicate() } catch (_) { value = false }
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'))
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

test('buildExists is false for a missing dist and true for a built one', async () => {
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  assert.equal(wc.buildExists(dist), false)

  fs.mkdirSync(dist, { recursive: true })
  // index.html is the marker — the Dockerfile checks the same file.
  fs.writeFileSync(path.join(dist, 'other.txt'), 'x')
  assert.equal(wc.buildExists(dist), false)

  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>')
  assert.equal(wc.buildExists(dist), true)

  // Never throws on nonsense input.
  assert.equal(wc.buildExists(null) === true || wc.buildExists(null) === false, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a build that exits 0 and produces index.html reports ok', async () => {
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  const script = fakeScript(dir, `mkdir -p "${dist}" && echo "<!doctype html>" > "${dist}/index.html" && echo "building..." && echo "done"`)

  const state = wc.startBuild({ dir: dist, command: `sh ${script}`, cwd: dir })
  assert.equal(state.running, true)

  await waitFor(() => !wc.buildState().running)
  const finished = wc.buildState()
  assert.equal(finished.ok, true)
  assert.equal(finished.error, '')
  assert.equal(wc.buildExists(dist), true)
  assert.ok(finished.tail.some(l => l.includes('done')), 'captured stdout should be in the tail')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an exit code of 0 with no output is still a failure', async () => {
  // The script can "succeed" while producing nothing (the Dockerfile guards the
  // same way), so the exit code alone must not be trusted.
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  const script = fakeScript(dir, 'echo "nothing to do"')

  wc.startBuild({ dir: dist, command: `sh ${script}`, cwd: dir })
  await waitFor(() => !wc.buildState().running)
  const finished = wc.buildState()
  assert.equal(finished.ok, false)
  assert.match(finished.error, /index\.html/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a non-zero exit reports the code and keeps the failing output', async () => {
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  const script = fakeScript(dir, 'echo "pnpm: not found" >&2\nexit 127')

  wc.startBuild({ dir: dist, command: `sh ${script}`, cwd: dir })
  await waitFor(() => !wc.buildState().running)
  const finished = wc.buildState()
  assert.equal(finished.ok, false)
  assert.match(finished.error, /code 127/)
  assert.ok(finished.tail.some(l => l.includes('pnpm: not found')), 'stderr should be captured')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('output is written to web-client/build.log next to the dist dir', async () => {
  const dir = tmpDir()
  const dist = path.join(dir, 'web-client', 'dist')
  const script = fakeScript(dir, `echo "line one" && echo "line two" && mkdir -p "${dist}" && echo x > "${dist}/index.html"`)

  wc.startBuild({ dir: dist, command: `sh ${script}`, cwd: dir })
  await waitFor(() => !wc.buildState().running)

  const logFile = wc.buildState().logFile
  assert.equal(path.dirname(logFile), path.join(dir, 'web-client'))
  const contents = fs.readFileSync(logFile, 'utf8')
  assert.match(contents, /line one/)
  assert.match(contents, /line two/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the in-memory tail is capped so a long build cannot grow unbounded', async () => {
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  const script = fakeScript(dir, 'i=0\nwhile [ $i -lt 200 ]; do echo "progress $i"; i=$((i + 1)); done')

  wc.startBuild({ dir: dist, command: `sh ${script}`, cwd: dir })
  await waitFor(() => !wc.buildState().running)
  const tail = wc.buildState().tail
  assert.ok(tail.length <= 40, `tail should be capped, got ${tail.length}`)
  // The LAST lines survive, not the first — they are what a failure is read from.
  assert.ok(tail.some(l => l.includes('progress 199')), 'the newest output should be retained')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('carriage-return progress output is split into lines instead of one blob', async () => {
  // pnpm/npm rewrite a progress line with \r and no newline; a readline-based
  // reader would stall on it.
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  const script = fakeScript(dir, 'printf "step 1\\rstep 2\\rstep 3\\n"')

  wc.startBuild({ dir: dist, command: `sh ${script}`, cwd: dir })
  await waitFor(() => !wc.buildState().running)
  const tail = wc.buildState().tail
  assert.ok(tail.some(l => l.includes('step 1')), 'CR-separated steps should each be a line')
  assert.ok(tail.some(l => l.includes('step 3')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('startBuild is a no-op while a build is already running', async () => {
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  const script = fakeScript(dir, 'sleep 2\necho "finished"')

  const first = wc.startBuild({ dir: dist, command: `sh ${script}`, cwd: dir })
  const second = wc.startBuild({ dir: dist, command: `sh ${script}`, cwd: dir })
  assert.equal(first.startedAt, second.startedAt, 'the second call must return the running build')

  await waitFor(() => !wc.buildState().running)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the default interpreter handles the bash-only header used by the real script', async () => {
  // Regression guard. scripts/build-web-client.sh starts with `set -euo pipefail`,
  // which dash (the /bin/sh symlink on Debian and Ubuntu) rejects with
  // "set: Illegal option -o pipefail". Running that script through `sh` therefore
  // failed on Linux, and the default here used to be `sh` — so the build never
  // started outside Docker. This fixture has the same header.
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  const script = path.join(dir, 'bash-only.sh')
  fs.writeFileSync(script, `#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p "${dist}"\necho "<html>client</html>" > "${dist}/index.html"\necho "built with bash"\n`)

  wc.startBuild({ dir: dist, script, cwd: dir })
  await waitFor(() => !wc.buildState().running)
  const finished = wc.buildState()
  assert.equal(finished.error, '', 'the bash-only header must not fail')
  assert.equal(finished.ok, true)
  assert.ok(finished.tail.some(l => l.includes('built with bash')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a command that cannot be spawned fails cleanly instead of throwing', async () => {
  const dir = tmpDir()
  const dist = path.join(dir, 'dist')
  const state = wc.startBuild({ dir: dist, command: 'this-command-does-not-exist-xyz', cwd: dir })
  assert.equal(state.running, true)
  await waitFor(() => !wc.buildState().running)
  const finished = wc.buildState()
  assert.equal(finished.ok, false)
  assert.ok(finished.error, 'an error message should be recorded')
  fs.rmSync(dir, { recursive: true, force: true })
})
