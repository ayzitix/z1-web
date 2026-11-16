// Offline `stack.search`: a fake broker answering the Stack Exchange v2.3
// search endpoint. The point of the file is the two clocks — a 429 with
// `Retry-After` is a temporary backoff, while `quota_remaining: 0` is the daily
// 300/day quota that only refills at 00:00 UTC — plus `accepted` normalisation
// and the quota footer.
//
// `stack.js` keeps its quota/backoff state at module level, so a scenario that
// spends a quota must not leak into the next one: each such scenario imports a
// fresh copy of the module through a distinct query string.
import { services } from '../module/index.js'
import { normaliseItems, readParams, searchUrl, nextUtcMidnight } from '../module/lib/stack.js'

delete process.env.Z1_SEARX_URL
delete process.env.Z1_SEARX_STATE

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

/** Fake broker: records the request, answers whatever `route` returns. */
function broker(route) {
  const requests = []
  const ctx = {
    net: {
      async request(request) {
        requests.push(request)
        return { status: 200, headers: {}, body: '', truncated: false, ...route(request) }
      },
    },
  }
  return { ctx, requests }
}

const answer = (body, status = 200, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

/** A pristine `runStackSearch`, with its own quota and backoff state. */
async function freshStack(tag) {
  const module = await import(`../module/lib/stack.js?scenario=${tag}`)
  return module.runStackSearch
}

const call = (ctx, args) => services.tools(ctx).call('stack.search', args)

const ITEMS = {
  items: [
    {
      title: 'How do I fix E0502? &quot;borrow&quot;',
      link: 'https://stackoverflow.com/questions/1',
      score: 42,
      answer_count: 7,
      accepted_answer_id: 99,
      tags: ['rust', 'borrow-checker', 'lifetimes', 'ownership', 'traits', 'extra'],
      creation_date: 1709337600,
    },
    {
      title: 'Second question',
      link: 'https://stackoverflow.com/questions/2',
      score: 3,
      answer_count: 0,
      accepted_answer_id: null,
      tags: ['rust'],
      creation_date: 1709424000,
    },
    { title: 'no link', score: 1, answer_count: 1, tags: [] },
    { title: '', link: 'https://stackoverflow.com/questions/3', score: 1, answer_count: 1, tags: [] },
    null,
  ],
  total: 1523,
  quota_remaining: 299,
  quota_max: 300,
}

// --- normalisation ---------------------------------------------------------

{
  const { ctx, requests } = broker(() => answer(ITEMS))
  const text = await call(ctx, { query: 'rust error E0502', tags: 'rust, borrow-checker' })
  check('the search hits /search/advanced on api.stackexchange.com',
    requests[0].url.startsWith('https://api.stackexchange.com/2.3/search/advanced?'), requests[0].url)
  check('tags are semicolon-joined', new URL(requests[0].url).searchParams.get('tagged') === 'rust;borrow-checker')
  check('the request identifies the module',
    requests[0].headers['user-agent'] === 'z1-web/0.3.3', requests[0].headers['user-agent'])

  const lines = text.split('\n')
  check('two usable items are rendered, malformed ones dropped',
    lines.filter((line) => /^\d+\. /.test(line)).length === 2, text)
  check('score, answers, accepted, tags and date are one fact line',
    lines[1] === '   score 42 · 7 answers · accepted · tags: rust, borrow-checker, lifetimes, ownership, traits · 2024-03-02',
    lines[1])
  check('only five tags are shown', (lines[1].match(/, /g) ?? []).length === 4, lines[1])
  check('a question without an accepted answer omits the flag',
    lines[3] === '   score 3 · 0 answers · tags: rust · 2024-03-03', lines[3])
  check('entities in a title are decoded', lines[0] === '1. How do I fix E0502? "borrow" — https://stackoverflow.com/questions/1', lines[0])
  check('the footer carries the site, the slice and the real quota',
    lines.at(-1) === '(stackoverflow · 2 of 1523 · quota 299/300)', lines.at(-1))
}

{
  const { ctx } = broker(() => answer({ ...ITEMS, items: [], total: 0 }))
  const text = await call(ctx, { query: 'zzqq nothing', site: 'askubuntu', tags: ['x'] })
  check('an empty answer names the query, the site and what to change',
    text === '(no questions for "zzqq nothing" on askubuntu; try fewer tags · drop accepted · use a different site · quota 299/300)',
    text)
}

// --- accepted normalisation ------------------------------------------------

{
  const off = readParams({ query: 'e0502', accepted: false })
  const unset = readParams({ query: 'e0502' })
  const on = readParams({ query: 'e0502', accepted: true })
  check('accepted:false is normalised to unset', off.accepted === undefined)
  check('accepted:false and an omitted argument share one URL',
    searchUrl(off) === searchUrl(unset), `${searchUrl(off)} vs ${searchUrl(unset)}`)
  check('accepted:true is sent', new URL(searchUrl(on)).searchParams.get('accepted') === 'true')
}

{
  const { ctx, requests } = broker(() => answer(ITEMS))
  await call(ctx, { query: 'accepted normalisation', accepted: false })
  const second = await call(ctx, { query: 'accepted normalisation' })
  check('accepted:false and an omitted argument share one cache entry',
    requests.length === 1, `${requests.length} requests`)
  check('the shared entry answers the second call from cache', second.includes('cached'), second.split('\n').at(-1))
}

// --- 429: backoff vs daily quota ------------------------------------------

{
  const run = await freshStack('retry-after')
  const { ctx, requests } = broker(() => answer(
    { error_message: 'too many requests from this IP', quota_remaining: 12, quota_max: 300 },
    429,
    { 'retry-after': '30' },
  ))
  const message = await errorOf(() => run(ctx, { query: 'x' }))
  check('429 + Retry-After is a temporary backoff, never a daily reset',
    /temporary throttle, not the 300\/day quota/.test(message) && !/quota exhausted/.test(message), message)
  check('the backoff names the Retry-After wait', /retry in 30s \(\d\d:\d\d:\d\d UTC\)/.test(message), message)
  check('a non-zero quota_remaining is not called exhausted', !/resets \d{4}-/.test(message), message)
  check('the 429 cost exactly one request', requests.length === 1, `${requests.length}`)
}

{
  const run = await freshStack('quota')
  const { ctx, requests } = broker(() => answer(
    { error_message: 'quota exceeded', quota_remaining: 0, quota_max: 300 },
    429,
  ))
  const message = await errorOf(() => run(ctx, { query: 'x' }))
  check('429 + quota_remaining:0 names the 00:00 UTC reset, not a backoff',
    /quota exhausted \(resets \d{4}-\d\d-\d\d 00:00 UTC \(in (?:\d+h(?: \d+m)?|\d+m)\)\)/.test(message),
    message)
  check('the exhausted-quota line states the daily allowance',
    message.includes('300 requests a day per IP') && !/temporary throttle/.test(message), message)

  const again = await errorOf(() => run(ctx, { query: 'a different query' }))
  check('an exhausted quota is refused locally, with no second request',
    requests.length === 1 && /quota exhausted/.test(again), `${requests.length} · ${again}`)
}

{
  const run = await freshStack('backoff-field')
  const { ctx, requests } = broker(() => answer({ ...ITEMS, backoff: 120 }))
  await run(ctx, { query: 'first' })
  const message = await errorOf(() => run(ctx, { query: 'second' }))
  check('a 200 carrying `backoff` sets a local wait, not a daily reset',
    /asked to back off · retry in 2m \(\d\d:\d\d:\d\d UTC\)/.test(message) && !/quota exhausted/.test(message), message)
  check('the local backoff costs no request', requests.length === 1, `${requests.length}`)
}

{
  const run = await freshStack('throttle-seconds')
  const { ctx } = broker(() => answer(
    { error_message: 'too many requests from this IP, more requests available in 600 seconds', quota_remaining: 5 },
    429,
  ))
  const message = await errorOf(() => run(ctx, { query: 'x' }))
  check('the "in N seconds" message text is read as the same backoff clock',
    /retry in 10m \(\d\d:\d\d:\d\d UTC\)/.test(message) && !/quota exhausted/.test(message), message)
}

{
  const at = nextUtcMidnight(Date.UTC(2026, 10, 16, 21, 48))
  check('the reset is the next 00:00 UTC', new Date(at).toISOString() === '2026-11-17T00:00:00.000Z',
    new Date(at).toISOString())
}

// --- normaliseItems is the only filter ------------------------------------

{
  const kept = normaliseItems(ITEMS.items)
  check('normaliseItems keeps the API order and the four fields',
    kept.length === 2 && kept[0].link === 'https://stackoverflow.com/questions/1' &&
      kept[0].accepted === true && kept[0].answers === 7 && kept[0].date === '2024-03-02', JSON.stringify(kept[0]))
  check('a missing answer_count becomes 0, never undefined',
    kept[1].answers === 0 && kept[1].accepted === false)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
