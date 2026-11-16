// Offline `web.fetch` and `web.status`: a fake broker that answers only URLs the
// manifest grants — `*` for public hosts, `127.0.0.1:8888` / `[::1]:8888` for
// loopback — so nothing here opens a socket or talks to a backend.
import { services } from '../module/index.js'
import { cacheBytes, cacheSize, clearCache } from '../module/lib/fetch.js'

delete process.env.Z1_SEARX_STATE
delete process.env.Z1_SEARX_URL

let checks = 0
let failures = 0
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

async function errorOf(fn) {
  try {
    await fn()
    return '(no error)'
  } catch (error) {
    return error.message
  }
}

const call = (ctx, name, args) => services.tools(ctx).call(name, args)

// --- fake host with the new host:port grant --------------------------------

/**
 * The grant the manifest asks for, applied the way the host must apply it: a
 * loopback address is allowed only on the port it names. That is the whole point
 * of `127.0.0.1:8888` — a bare `127.0.0.1` grant would hand the model every
 * local service on the machine.
 */
const GRANT = [
  { host: '127.0.0.1', port: 8888 },
  { host: '[::1]', port: 8888 },
]

function refusalFor(url) {
  const parsed = new URL(url)
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === 'localhost'
  if (!loopback) return undefined
  const port = parsed.port === '' ? 80 : Number(parsed.port)
  const granted = GRANT.some((entry) => entry.host === parsed.hostname && entry.port === port)
  return granted ? undefined : `net.request denied for host "${parsed.hostname}:${port}": host is outside the granted patterns`
}

/** Fake host broker: enforces the grant, records each request, routes by URL. */
function broker(route = () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body><p>public page</p></body></html>' })) {
  const requests = []
  const ctx = {
    net: {
      async request(request) {
        const refusal = refusalFor(request.url)
        if (refusal !== undefined) throw new Error(refusal)
        requests.push(request)
        return { status: 200, headers: {}, body: '', truncated: false, ...route(request.url) }
      },
    },
  }
  return { ctx, requests }
}

const json = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'application/json', ...headers }, body })
const text = (body) => ({ status: 200, headers: { 'content-type': 'text/plain' }, body })
const html = (body) => ({ status: 200, headers: { 'content-type': 'text/html' }, body })

// --- loopback grant --------------------------------------------------------

clearCache()
{
  const { ctx, requests } = broker()
  const refused = await errorOf(() => call(ctx, 'web.fetch', { url: 'http://127.0.0.1:35545/x' }))
  check('web.fetch refuses a loopback port that is not the backend',
    refused.startsWith('web.fetch: loopback is granted only for the local SearXNG at 127.0.0.1:8888') &&
      refused.includes('127.0.0.1:35545 is not the backend'),
    refused)
  check('that refusal costs no request', requests.length === 0, `${requests.length}`)
}

{
  const { ctx, requests } = broker(() => text('OK'))
  const answer = await call(ctx, 'web.fetch', { url: 'http://127.0.0.1:8888/healthz' })
  check('the granted loopback port is reachable through the broker',
    /^\(text\/plain · 2 chars · showing 1–2 · \d+ ms · cached: no\)\n\nOK$/.test(answer), JSON.stringify(answer))
  check('the granted request is the only one that left the module', requests.length === 1, `${requests.length}`)
}

{
  const { ctx, requests } = broker(() => text('OK'))
  const answer = await call(ctx, 'web.fetch', { url: 'http://[::1]:8888/healthz' })
  check('the IPv6 loopback grant works too',
    answer.includes('· 2 chars ·') && (requests[0]?.url ?? '').startsWith('http://[::1]:8888/'),
    requests[0]?.url ?? answer)
}

{
  const { ctx } = broker()
  const refusal = await errorOf(() => ctx.net.request({ url: 'http://127.0.0.1:35545/admin' }))
  check('the fake host refuses that port even without the local check',
    refusal.includes('outside the granted patterns') && refusal.includes('127.0.0.1:35545'), refusal)
  const allowed = await errorOf(() => ctx.net.request({ url: 'http://127.0.0.1:8888/healthz' }))
  check('the fake host allows the granted host:port', allowed === '(no error)', allowed)
}

// --- cache ----------------------------------------------------------------

clearCache()
{
  const page = `<html><head><title>Page</title></head><body><p>${'body text '.repeat(40)}</p></body></html>`
  const { ctx, requests } = broker(() => html(page))
  const first = await call(ctx, 'web.fetch', { url: 'https://a.test/p#section' })
  const second = await call(ctx, 'web.fetch', { url: 'https://a.test/p' })
  check('a fragment is stripped, so #section and the bare URL share one entry',
    requests.length === 1 && cacheSize() === 1, `${requests.length} requests, ${cacheSize()} entries`)
  check('the fragment never reaches the broker', !(requests[0]?.url ?? '').includes('#'), requests[0]?.url)
  check('the repeat is answered from cache', second.includes('cached: yes'), second.split('\n')[1])
  check('the two answers differ only in the cached flag',
    second.replace('cached: yes', 'cached: no') === first)

  const slice = await call(ctx, 'web.fetch', { url: 'https://a.test/p', offset: 2, maxChars: 1000 })
  check('offset and maxChars are not part of the key (paging costs no request)',
    requests.length === 1, `${requests.length} requests`)
  check('the slice is served from the same cached page', slice.includes('cached: yes'), slice.split('\n')[1])
  // The page is ~399 chars, so `maxChars: 1000` is deliberately not filled: the
  // footer must show the whole-document size and stop at the real end.
  check('the slice keeps the whole-document size in the footer', /· \d+ chars · showing 2–\d+ ·/.test(slice), slice.split('\n')[1])
}

clearCache()
{
  const huge = `<html><body><p>${'y'.repeat(2_200_000)}</p></body></html>`
  const { ctx, requests } = broker(() => html(huge))
  await call(ctx, 'web.fetch', { url: 'https://a.test/big-1' })
  check('one large page is cached', cacheSize() === 1, `${cacheSize()}`)
  await call(ctx, 'web.fetch', { url: 'https://a.test/big-2' })
  check('the byte cap evicts by weight, not by entry count', cacheSize() === 1, `${cacheSize()}`)
  check('cached text stays inside the 8 MiB budget', cacheBytes() <= 8 * 1024 * 1024, `${cacheBytes()}`)
  await call(ctx, 'web.fetch', { url: 'https://a.test/big-1' })
  check('the evicted page is fetched again', requests.length === 3, `${requests.length}`)
  check('the cache is keyed by URL, so the other page is still there', cacheSize() === 1)
}

// --- web.status fingerprint ------------------------------------------------

process.env.Z1_SEARX_URL = 'http://127.0.0.1:8888'
const line = (answer) => answer.split('\n')[0]

{
  const { ctx, requests } = broker(() => text('OK'))
  const answer = await call(ctx, 'web.status', {})
  check('HTTP 200 + OK is healthy, with the probe time',
    /^searxng · http:\/\/127\.0\.0\.1:8888 · healthy · \d+ ms$/.test(line(answer)), line(answer))
  check('a healthy probe stops at /healthz',
    requests.length === 1 && new URL(requests[0].url).pathname === '/healthz', requests.map((r) => r.url).join(' '))
}

{
  const page = '<html><body>proxy landing page</body></html>'
  const { ctx, requests } = broker(() => html(page))
  const answer = await call(ctx, 'web.status', {})
  check('HTTP 200 with an HTML page is unhealthy, never healthy',
    line(answer) === 'searxng · http://127.0.0.1:8888 · unhealthy · HTTP 200 but the body is not SearXNG (no OK from /healthz, no searxng in /config)',
    line(answer))
  check('a 200 that is not SearXNG is confirmed by /config',
    requests.map((request) => new URL(request.url).pathname).join(',') === '/healthz,/config',
    requests.map((request) => new URL(request.url).pathname).join(','))
}

{
  const { ctx } = broker(() => ({ status: 500, headers: {}, body: 'boom' }))
  const answer = await call(ctx, 'web.status', {})
  check('HTTP 500 is unhealthy with the status as its reason',
    line(answer) === 'searxng · http://127.0.0.1:8888 · unhealthy · HTTP 500', line(answer))
}

{
  const { ctx } = broker((url) => url.endsWith('/healthz')
    ? html('<html><body>landing</body></html>')
    : json('{"brand":{"name":"searxng"}}'))
  const answer = await call(ctx, 'web.status', {})
  check('/config JSON naming searxng rescues a non-OK /healthz',
    /^searxng · http:\/\/127\.0\.0\.1:8888 · healthy · \d+ ms$/.test(line(answer)), line(answer))
}

{
  const { ctx } = broker(() => json('{"brand":{"name":"gitea"}}'))
  const answer = await call(ctx, 'web.status', {})
  check('another service on port 8888 is called unhealthy, not healthy',
    outLineIsUnhealthy(answer), line(answer))
}

function outLineIsUnhealthy(answer) {
  return line(answer).startsWith('searxng · http://127.0.0.1:8888 · unhealthy · ')
}

{
  const { ctx } = broker(() => {
    throw new Error('fetch failed')
  })
  const answer = await call(ctx, 'web.status', {})
  check('a dead backend is down, and status never throws',
    line(answer) === 'searxng · http://127.0.0.1:8888 · down · connection refused · z1 starts it on launch (first run installs ~120 MB)',
    line(answer))
}

delete process.env.Z1_SEARX_URL

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
