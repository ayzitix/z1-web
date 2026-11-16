/**
 * `stack.search`: Stack Exchange's public search API, rendered as a short list.
 *
 * One anonymous GET to `https://api.stackexchange.com/2.3/search/advanced`
 * returns questions, their score, answer count, accepted flag, tags and
 * creation date — the fields that let a model decide whether a page is worth
 * opening — and never a body, which is what keeps the answer inside a few
 * hundred tokens. `filter=default` is explicit: the API's default filter
 * already omits bodies, and naming it means a future default cannot quietly
 * start shipping them.
 *
 * Quotas are the whole design constraint here:
 *
 * - 300 requests a day per IP, anonymous, and Stack Exchange counts *every*
 *   call including a 400. So arguments are validated and the URL is built
 *   locally before a request is made: a typo costs nothing.
 * - `quota_remaining` / `quota_max` are read from every response and repeated
 *   in the footer, so the model can see the budget draining. When it reaches
 *   zero the tools refuse locally (until 00:00 UTC) instead of spending a call
 *   to be told 429.
 * - `backoff` (and the `Retry-After` header on 429) is recorded and honoured:
 *   a second call before it elapses is refused with the remaining seconds, not
 *   sent. Hammering after a backoff is how an IP gets throttled harder.
 *
 * Only successful answers are cached (10 minutes, 50 entries, keyed on site,
 * query, tags, accepted, sort and limit); a failure is never cached, so the
 * next attempt after a fixed argument really does hit the network.
 *
 * @module z1-web/stack
 */

import { cacheKey, createCache } from './cache.js'
import {
  renderStackEmpty,
  renderStackResults,
  clockUtc,
  isoDay,
  oneLine,
} from './format.js'
import { header, headerInt, requestJson, toWebError, bodyMessage, VERSION, timeoutMs, WebError } from './net.js'

export const API = 'https://api.stackexchange.com/2.3'

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 50
const DEFAULT_SITE = 'stackoverflow'
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 30
const MAX_TAGS = 5
const MAX_QUERY = 500

/** `relevance` is the API default; the other three reorder the same matches. */
const SORTS = new Set(['relevance', 'votes', 'creation', 'activity'])

/** A site slug: `stackoverflow`, `askubuntu`, `math.stackexchange`, `ru.stackoverflow`. */
const SITE_PATTERN = /^[a-z0-9][a-z0-9.-]*$/
/** Tags tolerate `c++`, `c#`, `.net`, `objective-c`; they must not break `tagged=a;b`. */
const TAG_PATTERN = /^[^\s;,&<>"']{1,35}$/

const cache = createCache({ ttlMs: CACHE_TTL_MS, max: CACHE_MAX })

/** Last quota we were told about, any backoff we must wait out, and the daily reset. */
const state = {
  remaining: undefined,
  max: undefined,
  /** Next 00:00 UTC, only when the payload says the daily quota is gone. */
  quotaResetAt: undefined,
  /** A short, server-requested pause from `backoff`/`Retry-After`. */
  backoffUntil: 0,
}

/** Test seam: forget cached answers and quota state. */
export function clearCache() {
  cache.clear()
  state.remaining = undefined
  state.max = undefined
  state.quotaResetAt = undefined
  state.backoffUntil = 0
}

/** Test/diagnostic seam: current cache occupancy. */
export function cacheSize() {
  return cache.size
}

/** Test/diagnostic seam: what the module believes about the quota. */
export function quotaState() {
  return { ...state }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(`stack.search: ${message}`)
}

/** Validate the raw model arguments into the exact parameters we will send. */
export function readParams(raw) {
  if (raw === undefined || raw === null) fail('query is required')
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('expects an object of arguments')

  const rawQuery = raw['query']
  if (rawQuery === undefined || rawQuery === null) fail('query is required')
  if (typeof rawQuery !== 'string') fail('query must be a non-empty string')
  const query = rawQuery.trim()
  if (query === '') fail('query must be a non-empty string')
  if (query.length > MAX_QUERY) fail(`query is longer than ${MAX_QUERY} characters; shorten it`)

  let site = DEFAULT_SITE
  if (raw['site'] !== undefined && raw['site'] !== null) {
    if (typeof raw['site'] !== 'string') fail('site must be a site slug like stackoverflow or askubuntu')
    site = raw['site'].trim().toLowerCase()
    if (!SITE_PATTERN.test(site)) {
      fail(
        `site must be a slug like stackoverflow, askubuntu, superuser or serverfault (got ${JSON.stringify(raw['site'])})`,
      )
    }
  }

  const tags = readTags(raw['tags'])

  let accepted
  if (raw['accepted'] !== undefined && raw['accepted'] !== null) {
    if (typeof raw['accepted'] !== 'boolean') fail('accepted must be a boolean')
    // The API has no "unaccepted" filter: only `accepted=true` is ever sent, so
    // `false` describes no request. Normalise it to "unset" here so it also
    // leaves the cache key alone — `accepted:false` and an omitted argument
    // share one URL and one cached answer.
    if (raw['accepted'] === true) accepted = true
  }

  let sort = 'relevance'
  if (raw['sort'] !== undefined && raw['sort'] !== null) {
    if (typeof raw['sort'] !== 'string' || !SORTS.has(raw['sort'])) {
      fail('sort must be one of relevance, votes, creation, activity')
    }
    sort = raw['sort']
  }

  return { query, site, tags, accepted, sort, limit: readLimit(raw['limit']) }
}

function readTags(value) {
  if (value === undefined || value === null) return []
  const list = typeof value === 'string' ? value.split(/[,;]/) : Array.isArray(value) ? value : undefined
  if (list === undefined) fail('tags must be a string or an array of strings')

  const tags = []
  for (const item of list) {
    if (typeof item !== 'string') fail('tags must be a string or an array of strings')
    const tag = item.trim().toLowerCase()
    if (tag === '') continue
    if (!TAG_PATTERN.test(tag)) fail(`tag ${JSON.stringify(item)} is not a valid Stack Exchange tag`)
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > MAX_TAGS) fail(`at most ${MAX_TAGS} tags are allowed (got ${tags.length})`)
  return tags
}

function readLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(number) || number < 1 || number > MAX_LIMIT) {
    fail(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  return number
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** The search URL; `tagged` is semicolon-joined, as the API expects. */
export function searchUrl(params, base = API) {
  const url = new URL(`${base}/search/advanced`)
  url.searchParams.set('order', 'desc')
  url.searchParams.set('sort', params.sort)
  url.searchParams.set('q', params.query)
  url.searchParams.set('site', params.site)
  url.searchParams.set('pagesize', String(params.limit))
  url.searchParams.set('filter', 'default')
  if (params.tags.length > 0) url.searchParams.set('tagged', params.tags.join(';'))
  if (params.accepted === true) url.searchParams.set('accepted', 'true')
  return url.toString()
}

/** Next 00:00 UTC: when the anonymous quota refills. */
export function nextUtcMidnight(now = Date.now()) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

function humanIn(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** `2026-11-16 00:00 UTC (in 3h 12m)`, for a quota that ran out. */
function resetText(at) {
  const iso = new Date(at).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC (in ${humanIn(at - Date.now())})`
}

/** Refuse locally while a backoff or an exhausted daily quota is outstanding. */
function refuseEarly() {
  const now = Date.now()
  if (now < state.backoffUntil) {
    const wait = state.backoffUntil - now
    fail(
      `Stack Exchange asked to back off · retry in ${humanIn(wait)} ` +
        `(${clockUtc(Math.ceil(state.backoffUntil / 1000))})`,
    )
  }
  if (state.remaining === 0 && state.quotaResetAt !== undefined && now < state.quotaResetAt) {
    fail(
      `Stack Exchange quota exhausted (resets ${resetText(state.quotaResetAt)}) · ` +
        'the anonymous quota is 300 requests a day per IP',
    )
  }
}

/**
 * Record whatever the payload says about quota and backoff. The two are
 * different clocks: `backoff`/`Retry-After` is "wait this long before the next
 * call" (seconds to hours), while the anonymous 300/day quota refills only at
 * 00:00 UTC. A 429 with `Retry-After: 12345` therefore shortens nothing and
 * must not be reported as a daily reset.
 */
function noteBudget(data, headers) {
  if (data !== null && typeof data === 'object') {
    const remaining = Number.isFinite(data.quota_remaining) ? Math.trunc(data.quota_remaining) : undefined
    const max = Number.isFinite(data.quota_max) ? Math.trunc(data.quota_max) : undefined
    if (remaining !== undefined) state.remaining = remaining
    if (max !== undefined) state.max = max
    if (remaining === 0) state.quotaResetAt = nextUtcMidnight()
    if (Number.isFinite(data.backoff) && data.backoff > 0) {
      state.backoffUntil = Math.max(state.backoffUntil, Date.now() + Math.trunc(data.backoff) * 1000)
    }
  }
  const retryAfter = headerInt(headers, 'retry-after')
  if (retryAfter !== undefined && retryAfter > 0) {
    state.backoffUntil = Math.max(state.backoffUntil, Date.now() + retryAfter * 1000)
  }
}

/** ``No site found for name `x` `` → `x`; also ``No site found for the host `x` ``. */
function unknownSiteFrom(message) {
  const match = /no site found for (?:name|the host)\s+`([^`]+)`/i.exec(message)
  return match === null ? undefined : match[1]
}

/** Seconds from ``...more requests available in 12345 seconds``. */
function throttledSeconds(message) {
  const match = /in (\d+) seconds?/i.exec(message)
  return match === null ? undefined : Number(match[1])
}

async function fetchStack(ctx, params) {
  const url = searchUrl(params)
  const timeout = timeoutMs()

  let response
  try {
    response = await requestJson(ctx, url, {
      headers: {
        accept: 'application/json',
        'user-agent': `z1-web/${VERSION}`,
      },
      timeout,
    })
  } catch (error) {
    const web = error instanceof WebError ? error : toWebError(error)
    if (web.kind === 'timeout') fail(`Stack Exchange did not answer within ${timeout} ms`)
    if (web.kind === 'denied') fail(`the host refused the request to api.stackexchange.com · ${web.message}`)
    fail('Stack Exchange is unreachable · check the network, or retry in a moment')
  }

  noteBudget(response.data, response.headers)
  const message = bodyMessage(response.body)

  if (response.status === 429) {
    // `Retry-After` and `backoff` are already recorded by `noteBudget`. The
    // message's own "in N seconds" is the same clock; the daily reset is a
    // separate fact that only `quota_remaining: 0` may establish.
    const seconds = throttledSeconds(message)
    if (seconds !== undefined) {
      state.backoffUntil = Math.max(state.backoffUntil, Date.now() + seconds * 1000)
    }
    if (state.remaining === 0) {
      state.quotaResetAt = nextUtcMidnight()
      fail(`Stack Exchange quota exhausted (resets ${resetText(state.quotaResetAt)}) · 300 requests a day per IP`)
    }
    const wait = state.backoffUntil > Date.now()
      ? `retry in ${humanIn(state.backoffUntil - Date.now())} (${clockUtc(Math.ceil(state.backoffUntil / 1000))})`
      : 'retry in a minute'
    fail(
      `Stack Exchange rate-limited the request (HTTP 429) · ${wait} — ` +
        'a temporary throttle, not the 300/day quota',
    )
  }
  if (response.status === 400) {
    const site = unknownSiteFrom(message)
    if (site !== undefined) {
      fail(
        `unknown site ${JSON.stringify(site)} · try stackoverflow, askubuntu, superuser or serverfault, ` +
          'or any slug from https://api.stackexchange.com/2.3/sites',
      )
    }
    fail(`Stack Exchange rejected the request (HTTP 400${message === '' ? '' : ` · ${message}`})`)
  }
  if (response.status !== 200) {
    fail(
      `Stack Exchange answered HTTP ${response.status}${message === '' ? '' : ` · ${message}`} · retry later`,
    )
  }
  if (response.json !== true || response.data === null || typeof response.data !== 'object') {
    fail('Stack Exchange returned a body that is not a JSON object · retry later')
  }
  return response
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Keep the fields we render, drop everything else, in the API's order. */
export function normaliseItems(items, limit) {
  const list = Array.isArray(items) ? items : []
  const results = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.link !== 'string' || !/^https?:\/\//i.test(item.link)) continue
    if (typeof item.title !== 'string' || item.title.trim() === '') continue

    const record = {
      title: oneLine(item.title),
      link: item.link,
      score: Number.isFinite(item.score) ? Math.trunc(item.score) : 0,
      answers: Number.isFinite(item.answer_count) ? Math.trunc(item.answer_count) : 0,
      accepted: item.accepted_answer_id !== undefined && item.accepted_answer_id !== null,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [],
    }
    const date = isoDay(item.creation_date)
    if (date !== undefined) record.date = date
    results.push(record)
    if (limit !== undefined && results.length >= limit) break
  }
  return results
}

function quotaLabel() {
  if (state.remaining === undefined || state.max === undefined) return undefined
  return `${state.remaining}/${state.max}`
}

function keyOf(params) {
  return cacheKey([
    'stack',
    params.site,
    params.query,
    params.tags.join(','),
    params.accepted === undefined ? '' : String(params.accepted),
    params.sort,
    params.limit,
  ])
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run one Stack Exchange search and return the model-facing text. */
export async function runStackSearch(ctx, raw) {
  const params = readParams(raw)
  const key = keyOf(params)
  const quota = quotaLabel()

  const cached = cache.get(key)
  if (cached !== undefined) {
    return renderAnswer(params, { ...cached, quota: quotaLabel(), cached: true })
  }

  refuseEarly()
  const response = await fetchStack(ctx, params)
  const data = response.data
  const results = normaliseItems(data.items, params.limit)
  const rawTotal = Number.isFinite(data.total) ? Math.trunc(data.total) : results.length
  const value = { results, total: Math.max(rawTotal, results.length) }

  cache.set(key, value)
  return renderAnswer(params, { ...value, quota: quotaLabel(), cached: false })
}

function renderAnswer(params, answer) {
  if (answer.results.length === 0) {
    return renderStackEmpty({ query: params.query, site: params.site, quota: answer.quota, cached: answer.cached })
  }
  return renderStackResults({
    site: params.site,
    results: answer.results,
    total: answer.total,
    quota: answer.quota,
    cached: answer.cached,
  })
}
