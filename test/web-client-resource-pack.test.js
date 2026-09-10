'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { Writable } = require('node:stream')
const { handleResourcePackProxy } = require(path.join(__dirname, '..', 'web-client.js'))

// Capture what the proxy writes back to the browser without binding a port.
function makeRes () {
  const res = new Writable({ write (chunk, enc, cb) { res.chunks.push(Buffer.from(chunk)); cb() } })
  res.chunks = []
  res.status = null
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {}; return res }
  return res
}

function fakeReq (targetUrl) {
  return { url: '/resource-pack-proxy?url=' + encodeURIComponent(targetUrl) }
}

// Run the handler with a stubbed global fetch and wait for the response stream
// to finish. Returns { res, fetchArgs }.
async function runProxy (response, targetUrl = 'https://example.com/pack.zip') {
  const original = globalThis.fetch
  let fetchArgs = null
  globalThis.fetch = async (url, opts) => { fetchArgs = { url, opts }; return response }
  const res = makeRes()
  try {
    const finished = new Promise((resolve) => res.on('finish', resolve))
    handleResourcePackProxy(fakeReq(targetUrl), res, () => {})
    await finished
  } finally {
    globalThis.fetch = original
  }
  return { res, fetchArgs }
}

// Node's fetch decompresses gzip/br bodies but keeps the upstream
// content-length header (which then describes the COMPRESSED size). Forwarding
// it makes browsers truncate the pack — the reported "corrupted zip / can't
// find end of file".
test('does not forward a stale (compressed) content-length', async () => {
  const body = Buffer.from('PK\u0003\u0004 pretend zip bytes that are longer than the compressed size')
  const upstream = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-encoding': 'gzip', 'content-length': '12' }
  })
  const { res, fetchArgs } = await runProxy(upstream)
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Length'], undefined, 'a compressed body must not advertise its compressed length')
  assert.equal(res.headers['Content-Encoding'], undefined, 'the proxy never forwards content-encoding')
  assert.equal(Buffer.concat(res.chunks).length, body.length, 'the full decompressed body is streamed')
  assert.equal(fetchArgs.opts.headers['Accept-Encoding'], 'identity', 'requests uncompressed data upstream')
})

test('forwards content-length when the body really is uncompressed', async () => {
  const body = Buffer.from('PK\u0003\u0004 plain zip bytes')
  const upstream = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-length': String(body.length) }
  })
  const { res } = await runProxy(upstream)
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Length'], String(body.length))
  assert.equal(Buffer.concat(res.chunks).length, body.length)
})

test('still blocks loopback targets', async () => {
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return new Response('x') }
  const res = makeRes()
  try {
    const finished = new Promise((resolve) => res.on('finish', resolve))
    handleResourcePackProxy(fakeReq('http://127.0.0.1:9/secret'), res, () => {})
    await finished
  } finally {
    globalThis.fetch = original
  }
  assert.equal(res.status, 400)
  assert.equal(called, false, 'loopback targets never reach fetch')
})
