'use strict'
// ── Self-hosted Minecraft web client server ────────────────────────────────────
// Serves the production build of zardoy/minecraft-web-client (static files in
// ./web-client/dist) on its own local port so the dashboard's /play tab embeds
// a client we fully control — no third-party hosted client involved.
//
// The build is produced by:
//   npm run web-client:build          (clone + pnpm build into web-client/dist)
// or baked into the Docker image (see the Dockerfile's `webclient` stage).
//
// bot.js calls startWebClient() automatically when the Web GUI is on; the
// module can also be run standalone:  node web-client.js
const http = require('http')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { Readable } = require('stream')

// Text asset types worth gzipping — the client's main JS bundle is multi-MB.
const COMPRESSIBLE = { '.html': true, '.js': true, '.mjs': true, '.css': true, '.json': true, '.map': true, '.svg': true, '.txt': true, '.wasm': true }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
}

// ── Resource pack proxy ───────────────────────────────────────────────────────
// Fetches a resource pack URL server-side and streams it to the browser.
// Used by the web client when the direct browser fetch fails (GitHub
// redirects lack CORS headers, so browsers refuse to follow them).
// Only http(s) targets are allowed; loopback hosts are blocked so the
// endpoint can't be used to probe the local machine.
async function handleResourcePackProxy (req, res, log) {
  try {
    const q = new URL(req.url, 'http://localhost')
    const target = q.searchParams.get('url')
    const host = target ? new URL(target).hostname.toLowerCase() : ''
    const loopback = host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)
    if (!target || !/^https?:\/\//i.test(target) || loopback) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('bad resource pack url')
      return
    }
    const upstream = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (resource-pack-proxy)' } })
    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status || 502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('upstream error: ' + (upstream.status || 'unknown'))
      return
    }
    const headers = {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    }
    const length = upstream.headers.get('content-length')
    if (length) headers['Content-Length'] = length
    res.writeHead(200, headers)
    // Stream — never buffer the whole pack in memory.
    Readable.fromWeb(upstream.body).pipe(res)
  } catch (err) {
    try { res.writeHead(502); res.end('proxy error') } catch (_) {}
    log(`resource-pack proxy error: ${err && err.message ? err.message : String(err)}`)
  }
}

// Resolves with the real bound port once the server is listening; rejects on
// bind errors (EADDRINUSE / EACCES) so callers can fall back to the next port.
function listen(server, port, bind) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onListening); reject(e) }
    const onListening = () => { server.removeListener('error', onError); resolve(server.address().port) }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, bind)
  })
}

async function startWebClient({ dir, port = 8090, maxAttempts = 10, bind = '0.0.0.0', log = () => {} } = {}) {
  const distDir = dir || path.join(__dirname, 'web-client', 'dist')
  const indexPath = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    const reason = `web-client build not found at ${distDir} — run "npm run web-client:build" (or rebuild the Docker image)`
    log(reason)
    return { started: false, port: null, reason, server: null, dir: distDir }
  }

  // Track open connections so stopWebClient() can tear the server down
  // completely and free its memory (small-host friendly).
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    try {
      let p
      try { p = decodeURIComponent((req.url || '/').split('?')[0]) } catch (_) { p = '/' }
      // Same-origin proxy for server resource packs. Browsers refuse to follow
      // GitHub's CORS-less redirects (github.com → codeload/raw), so the web
      // client's resource-pack fetch falls back to this endpoint, which
      // fetches server-side (Node has no CORS) and streams the pack back.
      if (p === '/resource-pack-proxy') {
        handleResourcePackProxy(req, res, log)
        return
      }
      if (p === '/') p = '/index.html'
      // Resolve inside distDir only (block ../ traversal).
      let file = path.resolve(distDir, '.' + p)
      if (file !== distDir && !file.startsWith(distDir + path.sep)) {
        res.writeHead(403); res.end('forbidden'); return
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = indexPath
      const ext = path.extname(file).toLowerCase()
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      }
      // Serve gzip for text assets when the browser accepts it. Compression is
      // streamed — nothing is buffered or cached in memory, so serving the
      // multi-MB client bundle costs only a tiny rolling buffer.
      if (COMPRESSIBLE[ext] && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        headers['Content-Encoding'] = 'gzip'
        headers['Vary'] = 'Accept-Encoding'
        res.writeHead(200, headers)
        fs.createReadStream(file).pipe(zlib.createGzip({ level: 6 })).pipe(res)
        return
      }
      res.writeHead(200, headers)
      fs.createReadStream(file).pipe(res)
    } catch (err) {
      try { res.writeHead(500); res.end('internal error') } catch (_) {}
      log(`web-client serve error: ${err.stack || err.message || String(err)}`)
    }
  })

  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })

  const attempts = Math.max(1, maxAttempts)
  for (let i = 0; i < attempts; i++) {
    try {
      const actualPort = await listen(server, port + i, bind)
      log(`web client serving ${distDir} on ${bind}:${actualPort}`)
      return { started: true, port: actualPort, reason: '', server, dir: distDir, _sockets: sockets }
    } catch (e) {
      if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) continue
      const reason = e ? e.message || String(e) : 'listen failed'
      log(`web client listen error: ${reason}`)
      return { started: false, port: null, reason, server: null, dir: distDir }
    }
  }
  const reason = `could not bind web client server on ${bind}:${port}..${port + attempts - 1}`
  log(reason)
  return { started: false, port: null, reason, server: null, dir: distDir }
}

if (require.main === module) {
  const port = parseInt(process.env.MC_WEB_CLIENT_PORT || '8090', 10)
  const maxAttempts = parseInt(process.env.MC_WEB_CLIENT_PORT_MAX_ATTEMPTS || '10', 10)
  const bind = process.env.MC_WEB_CLIENT_BIND || '0.0.0.0'
  startWebClient({ port, maxAttempts, bind, log: m => console.log('[web-client] ' + m) }).then(h => {
    if (!h.started) { console.log('[web-client] ' + h.reason); process.exit(1) }
    console.log(`[web-client] http://${bind}:${h.port}/`)
  })
}

// Fully stops the client server: closes the listener AND destroys lingering
// connections so the process actually releases the memory, not just the port.
function stopWebClient(handle, log = () => {}) {
  if (!handle || !handle.server) return
  if (handle._sockets) for (const s of handle._sockets) { try { s.destroy() } catch (_) {} }
  try { handle.server.close() } catch (_) {}
  log('web client server stopped')
}

module.exports = { startWebClient, stopWebClient }