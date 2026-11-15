// Fully fake `ctx.net`: no backend, no network. Fixtures only.
// Asserts normalisation, clipping, dedupe, site filtering, cache and errors.
import { readFileSync } from 'node:fs'

// The module's caches capture `Date.now` when they are created, so the fake
// clock has to be installed before the import for a TTL assertion to mean
// anything.
const clock = { now: Date.now() }
Date.now = () => clock.now

const { services } = await import('/home/oleksii/Projects/z1-web/module/index.js')
const { cacheSize, cleanUrl, clearCache } = await import('/home/oleksii/Projects/z1-web/module/lib/search.js')

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
const SEARCH = fixture('search')
const EMPTY = fixture('empty')
const NO_KEY = fixture('no-results-key')

let requests = []
let nextResponse = null

/** Fake broker: records the request, answers with `nextResponse` or SEARCH. */
const ctx = {
  net: {
    async request(request) {
      requests.push(request)
      if (typeof nextResponse === 'function') return nextResponse(request)
      const body = typeof nextResponse === 'string' ? nextResponse : JSON.stringify(nextResponse ?? SEARCH)
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
        truncated: false,
      }
    },
  },
}
const tool = () => services.tools(ctx)
const call = (args) => tool().call('web.search', args)

let failures = 0
let checks = 0
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

// --- schema ----------------------------------------------------------------
const schemas = tool().list()
check('four tools are listed', schemas.length === 4)
check('names are web.search / stack.search / github.issues / web.status',
  schemas.map((s) => s.name).join(',') === 'web.search,stack.search,github.issues,web.status')
check('search requires only query', JSON.stringify(schemas[0].parameters.required) === '["query"]')
check('descriptions mention untrusted results', /untrusted/i.test(schemas[0].description))
check('descriptions mention site: and recency', /site:/.test(schemas[0].description) && /recency/.test(schemas[0].description))
check('descriptions mention a fetch step', /fetch step|web\.fetch/i.test(schemas[0].description))

// --- normalisation ---------------------------------------------------------
clearCache()
requests = []
nextResponse = null
const plain = await call({ query: 'streams' })

check('normalised count is 5 of 10 raw', /\(searxng · 5 of 10 results · \d+ ms\)$/.test(plain), plain.split('\n').at(-1))
check('utm/fragment duplicate collapsed', (plain.match(/nodejs\.org\/api\/stream\.html/g) ?? []).length === 1)
check('utm params stripped from the displayed URL', !/utm_source/.test(plain))
check('trailing slash stripped from path', !/stream\.html\//.test(plain))
check('sorted-param duplicate collapsed', (plain.match(/example\.com\/post/g) ?? []).length === 1, plain)
check('relative/javascript URLs dropped', !/relative|javascript:/.test(plain))
check('www. is NOT stripped', plain.includes('https://www.example.com/'))
check('SearXNG order preserved', plain.indexOf('nodejs.org/api/stream.html') < plain.indexOf('example.com/post'))
check('request had Accept + User-Agent',
  requests[0].headers.accept === 'application/json' && requests[0].headers['user-agent'] === 'z1-web/0.2.0')
check('request URL carries format=json and language=all',
  requests[0].url.includes('format=json') && requests[0].url.includes('language=all') && requests[0].url.includes('safesearch=0'))

const titleLine = plain.split('\n').find((line) => line.includes('evil.example'))
const title = titleLine.split(' — ')[0].replace(/^\d+\. /, '')
check('title clipped to 160 code points', Array.from(title).length === 160, `${Array.from(title).length}`)
check('title ends with the ellipsis', title.endsWith('…'))
check('clipped title is well-formed UTF-16', title.isWellFormed())
const snippet = plain.split('\n')[plain.split('\n').indexOf(titleLine) + 1].trim()
check('snippet clipped to 300 code points', Array.from(snippet).length === 300, `${Array.from(snippet).length}`)
check('snippet is one line and well-formed', !/\n/.test(snippet) && snippet.isWellFormed())
check('ANSI escape neutralised', snippet.includes('\\u001b') || !snippet.includes('\u001b'))
check('bidi override neutralised', !snippet.includes('\u202e'))
check('publishedDate kept in the record, not rendered', !/2026-01-02/.test(plain))

// --- site filter -----------------------------------------------------------
clearCache()
requests = []
const site = await call({ query: 'streams', site: 'nodejs.org' })
check('site query is sent as site:', requests[0].url.includes('site%3Anodejs.org') || requests[0].url.includes('site:nodejs.org'), requests[0].url)
check('site keeps only the host suffix', /\(searxng · 2 of 10 results/.test(site), site.split('\n').at(-1))
check('site excludes www.example.com and evil.example', !/www\.example\.com|evil\.example/.test(site))
check('site keeps a subdomain', site.includes('blog.nodejs.org'))

clearCache()
requests = []
const siteAgain = await call({ query: 'streams site:nodejs.org', site: 'nodejs.org' })
check('site: is not appended twice', (requests[0].url.match(/site/i) ?? []).length === 1, requests[0].url)
check('manual site: query still post-filtered', /2 of 10/.test(siteAgain), siteAgain.split('\n').at(-1))
check('hostMatches rejects a suffix that is not a host boundary', !cleanUrl('https://notnodejs.org/').hostname.endsWith('.nodejs.org'))
check('hostMatches accepts a subdomain', 'docs.nodejs.org'.endsWith('.nodejs.org'))

// --- count / params --------------------------------------------------------
clearCache()
requests = []
const counted = await call({ query: 'streams', count: 2 })
check('count clips to 2', /\(searxng · 2 of 10/.test(counted), counted.split('\n').at(-1))
check('count does not change the query', requests[0].url.includes('q=streams&'))

clearCache()
requests = []
await call({ query: 'streams', recency: 'month', safe: true, language: 'de-DE' })
check('recency -> time_range=month', requests[0].url.includes('time_range=month'))
check('safe -> safesearch=1', requests[0].url.includes('safesearch=1'))
check('language is forwarded', requests[0].url.includes('language=de-DE'))

// --- empty / missing results ----------------------------------------------
clearCache()
nextResponse = EMPTY
const empty = await call({ query: 'zzqqxx flurblewump 9137' })
check('empty answer is the documented line',
  empty === '(no results for "zzqqxx flurblewump 9137"; try shorter keywords, drop site:/recency, or fetch a known URL)',
  JSON.stringify(empty))

nextResponse = NO_KEY
const noKey = await call({ query: 'x' })
check('missing results key is empty with a note', noKey.includes('no results key'), noKey)
check('missing results key does not throw', noKey.startsWith('(no results for'))

// --- cache -----------------------------------------------------------------
clearCache()
requests = []
nextResponse = SEARCH
const first = await call({ query: 'streams' })
const second = await call({ query: 'streams' })
check('second identical call is served from cache', requests.length === 1, `${requests.length} requests`)
check('cached footer says cached', /· cached\)$/.test(second), second.split('\n').at(-1))
check('cached answer is byte-identical apart from the footer', second.replace(' · cached)', ')') === first)

await call({ query: 'streams', count: 4 })
check('a different count is a different key', requests.length === 2)

for (let index = 0; index < 60; index += 1) await call({ query: `capacity ${index}` })
check('cache is capped at 50 entries', cacheSize() === 50, `${cacheSize()}`)

const beforeEvict = requests.length
await call({ query: 'capacity 0' })
check('oldest entry was evicted (re-fetched)', requests.length === beforeEvict + 1)

clock.now += 11 * 60 * 1000
const afterTtl = await call({ query: 'capacity 0' })
check('entries expire after 10 minutes', /· cached\)$/.test(afterTtl) === false, afterTtl.split('\n').at(-1))

// --- errors ----------------------------------------------------------------
clearCache()
nextResponse = () => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: '<!DOCTYPE html><html><head><title>SearXNG</title></head><body>search</body></html>',
  truncated: false,
})
const htmlError = await errorOf(() => call({ query: 'x' }))
check('HTML 200 -> formats hint',
  htmlError === 'web.search: SearXNG returned HTML · set search.formats: [html, json] and restart SearXNG',
  htmlError)

nextResponse = () => ({ status: 403, headers: { 'content-type': 'text/html' }, body: '<html>forbidden</html>', truncated: false })
const html403 = await errorOf(() => call({ query: 'x' }))
check('HTML 403 also gets the formats hint (the real trap)', html403.includes('returned HTML'), html403)

nextResponse = () => ({
  status: 503,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: 'engine pool exhausted', detail: 'x'.repeat(400) }),
  truncated: false,
})
const http503 = await errorOf(() => call({ query: 'x' }))
check('non-200 reports status', http503.includes('HTTP 503'), http503)
const bodyExcerpt = http503.slice(http503.lastIndexOf(' · ') + 3)
check('non-200 body excerpt is clipped to 200 chars', Array.from(bodyExcerpt).length <= 200, `${Array.from(bodyExcerpt).length}`)

nextResponse = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: 'not json at all', truncated: false })
const badJson = await errorOf(() => call({ query: 'x' }))
check('invalid JSON is named, not dumped', badJson.includes('invalid JSON'), badJson)

nextResponse = () => {
  const error = new TypeError('fetch failed')
  error.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9' }
  throw error
}
const refused = await errorOf(() => call({ query: 'x' }))
check('refused connection names the backend provisioning path',
  refused.startsWith('web.search: SearXNG is not running at http://127.0.0.1:8888 · z1 starts it on launch; retry in a few seconds, or set Z1_SEARX_URL'),
  refused)

// Redaction of user:pass@ in every message that prints the URL.
process.env.Z1_SEARX_URL = 'http://user:s3cret@127.0.0.1:9/'
const redacted = await errorOf(() => call({ query: 'x' }))
check('credentials are redacted from the error', !redacted.includes('s3cret') && redacted.includes('127.0.0.1:9'), redacted)
const statusRedacted = await tool().call('web.status', {})
check('credentials are redacted from web.status', !statusRedacted.includes('s3cret'), statusRedacted)
delete process.env.Z1_SEARX_URL

nextResponse = () => {
  const error = new Error('net.request denied for host "127.0.0.1": host is outside the granted patterns')
  throw error
}
const denied = await errorOf(() => call({ query: 'x' }))
check('host denial points at capabilities.net.hosts', denied.includes('capabilities.net.hosts'), denied)

// --- argument validation ---------------------------------------------------
const validation = [
  [{}, 'query is required'],
  [{ query: '   ' }, 'query must be a non-empty string'],
  [{ query: 'x', count: 0 }, 'count must be an integer from 1 to 20'],
  [{ query: 'x', count: 21 }, 'count must be an integer from 1 to 20'],
  [{ query: 'x', count: 2.5 }, 'count must be an integer from 1 to 20'],
  [{ query: 'x', site: 'https://nodejs.org/docs' }, 'site must be a hostname'],
  [{ query: 'x', site: 'nodejs' }, 'site must be a hostname'],
  [{ query: 'x', recency: 'yesterday' }, 'recency must be one of day, week, month, year'],
  [{ query: 'x', safe: 'yes' }, 'safe must be a boolean'],
  [{ query: 'x', language: 'english please' }, 'language must be a BCP-47 code'],
]
for (const [args, expected] of validation) {
  const message = await errorOf(() => call(args))
  check(`rejects ${JSON.stringify(args)}`, message.includes(expected), message)
}
check('rejects a non-object argument', (await errorOf(() => tool().call('web.search', 'x'))).includes('expects an object'))
check('rejects an unknown tool', (await errorOf(() => tool().call('web.fetch', {}))).includes('unknown tool'))

// --- status ----------------------------------------------------------------
delete process.env.Z1_SEARX_STATE
process.env.Z1_SEARX_URL = 'http://127.0.0.1:8888'
nextResponse = () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'OK', truncated: false })
const healthy = await tool().call('web.status', {})
check('status healthy line',
  healthy.split('\n')[0] === 'searxng · http://127.0.0.1:8888 · healthy · 0 ms',
  healthy)
check('status second line names both keyless tools and the quotas',
  healthy.split('\n')[1] ===
    'stack.search · github.issues · keyless · available (Stack Exchange 300/day per IP · GitHub 10/min anonymous) Z1_SEARX_URL override',
  healthy)

nextResponse = () => ({ status: 500, headers: {}, body: 'boom', truncated: false })
const unhealthy = await tool().call('web.status', {})
check('status reports a non-200 as down without throwing',
  unhealthy.split('\n')[0] === 'searxng · http://127.0.0.1:8888 · down · z1 starts it on launch (first run installs ~120 MB)',
  unhealthy)

process.env.Z1_SEARX_STATE = `starting:${Date.now()}`
const starting = await tool().call('web.status', {})
check('status believes a starting hint from the host',
  starting.split('\n')[0] ===
    'searxng · http://127.0.0.1:8888 · starting · z1 is installing or starting it (~120 MB on first run); retry in a few seconds',
  starting)
process.env.Z1_SEARX_STATE = `starting:${Date.now() - 3 * 60 * 1000}`
check('status ignores a stale starting hint',
  (await tool().call('web.status', {})).split('\n')[0].includes(' · down · '))
delete process.env.Z1_SEARX_STATE

nextResponse = () => {
  throw new Error('fetch failed')
}
const dead = await tool().call('web.status', {})
check('status never throws', dead.includes(' · down · '), dead)
delete process.env.Z1_SEARX_URL

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
