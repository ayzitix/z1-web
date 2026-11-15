/**
 * `web.search`: one SearXNG query, normalised into records, rendered as text.
 *
 * The adapter is deliberately tiny and boring: a loopback GET to
 * `{Z1_SEARX_URL}/search?format=json`, a shape check, then normalisation. All
 * the policy lives after the response, because SearXNG is a metasearch front
 * end and its engines disagree about what they honour:
 *
 * - a result without an absolute `http(s)` URL is dropped (engines occasionally
 *   emit relative or `javascript:` links, and neither is fetchable);
 * - duplicates are collapsed on a normalised URL — fragment removed,
 *   `utm_*`/`fbclid`/`gclid`/`ref` removed, path trailing slashes removed,
 *   query parameters sorted for the key only, so the displayed URL keeps the
 *   order the site published. `www.` is **not** stripped: `www.x` and `x` can
 *   be different sites, and the model should see the URL it will fetch;
 * - `site` is both appended to the query as `site:` (engines that understand it
 *   return better results) and enforced afterwards by host suffix, because
 *   Bing and friends regularly ignore the operator. The two together are why a
 *   `site:` search returns few but correct hits;
 * - SearXNG's order is preserved and the first `count` kept: re-ranking here
 *   would override four engines' consensus with a heuristic.
 *
 * Text is clipped in `format.js` (160/300 characters), and every record is
 * plain data — nothing in a result is trusted or acted on.
 *
 * Caching: per process, keyed by the base URL plus every normalised parameter,
 * TTL 10 minutes, at most 50 entries, evicted oldest-first. Only successful
 * answers are cached (an empty list is an answer; an error is not), so a
 * container that comes up is not hidden by a cached failure. The footer says
 * `cached` and repeats the original latency rather than pretending the hit was
 * instant.
 *
 * @module z1-web/search
 */

import { clip, oneLine, renderEmpty, renderResults, renderStatus } from './format.js'
import {
  header,
  redactUrl,
  requestText,
  searxBaseUrl,
  searxBaseUrlIsOverride,
  timeoutMs,
  WebError,
} from './net.js'

/** Matches the manifest version; also the User-Agent suffix. */
export const VERSION = '0.1.0'

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 50
const DEFAULT_COUNT = 8
const MAX_COUNT = 20
const DEFAULT_LANGUAGE = 'all'
const TIME_RANGES = new Set(['day', 'week', 'month', 'year'])

/** Hostname suffix: at least two labels, no scheme, no path, no port. */
const SITE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref'])

/** Cache of successful searches: key -> { at, value }. */
const cache = new Map()

/** Test seam: empty the search cache. */
export function clearCache() {
  cache.clear()
}

/** Test/diagnostic seam: current cache occupancy. */
export function cacheSize() {
  return cache.size
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(`web.search: ${message}`)
}

/** Validate raw model arguments into the exact query we will send. */
export function readParams(raw) {
  if (raw === undefined || raw === null) fail('query is required')
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('expects an object of arguments')

  const rawQuery = raw['query']
  if (rawQuery === undefined || rawQuery === null) fail('query is required')
  if (typeof rawQuery !== 'string') fail('query must be a non-empty string')
  const query = rawQuery.trim()
  if (query === '') fail('query must be a non-empty string')
  if (query.length > 500) fail('query is longer than 500 characters; shorten it')

  const count = readCount(raw['count'])

  let site
  if (raw['site'] !== undefined) {
    if (typeof raw['site'] !== 'string') fail('site must be a hostname string like docs.python.org')
    site = raw['site'].trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
    if (!SITE_PATTERN.test(site)) {
      fail(`site must be a hostname like nodejs.org or docs.python.org (got ${JSON.stringify(raw['site'])})`)
    }
  }

  let language = DEFAULT_LANGUAGE
  if (raw['language'] !== undefined) {
    if (typeof raw['language'] !== 'string') fail('language must be a BCP-47 code like en or de-DE')
    const trimmed = raw['language'].trim()
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(trimmed) && trimmed !== 'all') {
      fail(`language must be a BCP-47 code like en, de-DE or all (got ${JSON.stringify(raw['language'])})`)
    }
    language = trimmed
  }

  let recency
  if (raw['recency'] !== undefined) {
    if (typeof raw['recency'] !== 'string' || !TIME_RANGES.has(raw['recency'])) {
      fail('recency must be one of day, week, month, year')
    }
    recency = raw['recency']
  }

  let safe = false
  if (raw['safe'] !== undefined) {
    if (typeof raw['safe'] !== 'boolean') fail('safe must be a boolean')
    safe = raw['safe']
  }

  return { query, count, site, language, recency, safe }
}

function readCount(value) {
  if (value === undefined || value === null) return DEFAULT_COUNT
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(number) || number < 1 || number > MAX_COUNT) {
    fail(`count must be an integer from 1 to ${MAX_COUNT}`)
  }
  return number
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * The SearXNG request URL. `site:` is appended only when the query does not
 * already carry one (a model may pass both by hand) and never duplicated.
 */
export function searchUrl(params, base = searxBaseUrl()) {
  const url = new URL(`${base}/search`)
  const query = shouldAppendSite(params) ? `${params.query} site:${params.site}` : params.query
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', params.language)
  url.searchParams.set('safesearch', params.safe ? '1' : '0')
  if (params.recency !== undefined) url.searchParams.set('time_range', params.recency)
  return url.toString()
}

function shouldAppendSite(params) {
  if (params.site === undefined) return false
  return !/\bsite:/i.test(params.query)
}

async function fetchJson(ctx, params) {
  const base = searxBaseUrl()
  const url = searchUrl(params, base)
  const timeout = timeoutMs()

  let response
  try {
    response = await requestText(ctx, url, {
      headers: {
        accept: 'application/json',
        'user-agent': `z1-web/${VERSION}`,
      },
      timeout,
    })
  } catch (error) {
    throw describeError(error, base, timeout)
  }

  const contentType = header(response.headers, 'content-type') ?? ''
  const body = response.body
  if (looksLikeHtml(body, contentType)) {
    throw new Error(
      `web.search: SearXNG returned HTML · set search.formats: [html, json] and restart the container${
        response.status === 200 ? '' : ` (HTTP ${response.status})`
      }`,
    )
  }
  if (response.status !== 200) {
    throw new Error(`web.search: SearXNG answered HTTP ${response.status} at ${redactUrl(base)} · ${excerpt(body)}`)
  }

  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error(`web.search: SearXNG returned invalid JSON at ${redactUrl(base)} · ${excerpt(body)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`web.search: SearXNG answered a JSON ${Array.isArray(data) ? 'array' : typeof data}, not an object`)
  }
  return { data, ms: response.ms }
}

/** True when the response is a page, not the JSON API (the `formats` trap). */
function looksLikeHtml(body, contentType) {
  if (/text\/html/i.test(contentType)) return true
  return /^\s*(?:<!doctype|<html|<\?xml|<head|<body)/i.test(body)
}

function excerpt(body) {
  const text = oneLine(typeof body === 'string' ? body : '')
  return text === '' ? '(empty body)' : clip(text, 200)
}

/** One actionable line per failure kind; never the raw stack. */
function describeError(error, base, timeout) {
  const web = error instanceof WebError ? error : null
  const kind = web?.kind

  if (kind === 'timeout') {
    return new Error(`web.search: SearXNG did not answer within ${timeout} ms · ${redactUrl(base)}`)
  }
  if (kind === 'unreachable') {
    return new Error(
      `web.search: SearXNG is not reachable at ${redactUrl(base)} · ` +
        `start it with ~/Projects/z1-web/scripts/searx-up.sh (or set Z1_SEARX_URL)`,
    )
  }
  if (kind === 'denied') {
    return new Error(
      `web.search: the host refused the request to ${redactUrl(base)} · ` +
        `add that host to manifest.json capabilities.net.hosts (${error.message})`,
    )
  }
  return new Error(`web.search: ${error instanceof Error ? error.message : String(error)}`)
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function isTracking(name) {
  const lower = name.toLowerCase()
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)
}

/**
 * Parse and clean a result URL: http(s) only, no fragment, no tracking
 * parameters, no trailing slashes on the path. Returns `undefined` when the
 * engine emitted something unfetchable.
 */
export function cleanUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.hostname === '') return undefined

  url.hash = ''
  for (const name of [...url.searchParams.keys()]) {
    if (isTracking(name)) url.searchParams.delete(name)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

/** Stable identity for de-duplication: sorted query parameters, no fragment. */
function dedupeKey(url) {
  const params = [...url.searchParams.entries()].sort((left, right) => {
    if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1
    return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0
  })
  const query = params.map(([name, value]) => `${name}=${value}`).join('&')
  return `${url.protocol}//${url.host}${url.pathname}${query === '' ? '' : `?${query}`}`
}

/** Host equals the site or is a subdomain of it. */
export function hostMatches(host, site) {
  const lower = host.toLowerCase()
  return lower === site || lower.endsWith(`.${site}`)
}

/**
 * Turn SearXNG's `results` into at most `count` clean records, preserving its
 * order. `total` is the number it returned, before any filtering.
 */
export function normaliseResults(raw, { count, site } = {}) {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const results = []

  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const url = cleanUrl(item.url)
    if (url === undefined) continue
    if (site !== undefined && !hostMatches(url.hostname, site)) continue

    const key = dedupeKey(url)
    if (seen.has(key)) continue
    seen.add(key)

    const title = typeof item.title === 'string' ? item.title : ''
    const snippet = typeof item.content === 'string' ? item.content : ''
    const engine = typeof item.engine === 'string' && item.engine !== ''
      ? item.engine
      : Array.isArray(item.engines)
        ? item.engines.filter((name) => typeof name === 'string').join(', ')
        : ''

    const record = {
      title: clip(oneLine(title), 160) || url.hostname,
      url: url.toString(),
      snippet: clip(oneLine(snippet), 300),
      engine,
    }
    if (typeof item.publishedDate === 'string' && item.publishedDate !== '') {
      record.publishedDate = item.publishedDate
    }
    results.push(record)
    if (count !== undefined && results.length >= count) break
  }

  return { results, total: list.length }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cacheKey(params, base) {
  const stable = [
    `base=${base}`,
    `query=${params.query}`,
    `count=${params.count}`,
    `site=${params.site ?? ''}`,
    `language=${params.language}`,
    `recency=${params.recency ?? ''}`,
    `safe=${params.safe ? '1' : '0'}`,
  ].join('\u0000')
  return stable
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  // Refresh insertion order so eviction is least-recently-used.
  cache.delete(key)
  cache.set(key, hit)
  return hit.value
}

function cacheSet(key, value) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Short deadline for a health probe: a status line must not hang a worker. */
const STATUS_TIMEOUT_CAP_MS = 3000

/**
 * `web.status`: ping `/healthz` and report two lines. Never throws — a status
 * tool that fails is useless, so every failure becomes the `unhealthy` word
 * plus a short reason.
 */
export async function runStatus(ctx) {
  const base = searxBaseUrl()
  const url = redactUrl(base)
  const override = searxBaseUrlIsOverride()
  const envTimeoutRaw = (process.env['Z1_WEB_TIMEOUT_MS'] ?? '').trim()
  const envTimeout = envTimeoutRaw === '' ? undefined : envTimeoutRaw
  const fetchState = 'web.fetch: not implemented yet'

  const probeTimeout = Math.min(timeoutMs(), STATUS_TIMEOUT_CAP_MS)
  let state = 'healthy'
  let detail

  try {
    const response = await requestText(ctx, `${base}/healthz`, {
      headers: { accept: 'text/plain', 'user-agent': `z1-web/${VERSION}` },
      timeout: probeTimeout,
    })
    if (response.status !== 200) {
      state = 'unhealthy'
      detail = `HTTP ${response.status}`
    }
  } catch (error) {
    state = 'unhealthy'
    const web = error instanceof WebError ? error : null
    if (web?.kind === 'timeout') detail = `no answer within ${probeTimeout} ms`
    else if (web?.kind === 'unreachable') detail = 'not reachable'
    else if (web?.kind === 'denied') detail = 'host refused the request'
    else detail = oneLine(error instanceof Error ? error.message : String(error))
  }

  return renderStatus({ url, state, detail, override, envTimeout, fetchState })
}

/** Run one search and return the model-facing text. Throws on failure. */
export async function runSearch(ctx, raw) {
  const params = readParams(raw)
  const base = searxBaseUrl()
  const key = cacheKey(params, base)

  const cached = cacheGet(key)
  if (cached !== undefined) {
    return renderAnswer(params, { ...cached, cached: true })
  }

  const { data, ms } = await fetchJson(ctx, params)
  const hasResults = Array.isArray(data.results)
  const normalised = normaliseResults(hasResults ? data.results : [], params)
  const value = {
    results: normalised.results,
    total: normalised.total,
    ms,
    // A missing `results` key is an answer (empty), so it is cached with its
    // note: every retry inside the TTL explains the same thing.
    note: hasResults ? undefined : 'the JSON had no results key',
  }

  cacheSet(key, value)
  return renderAnswer(params, { ...value, cached: false })
}

function renderAnswer(params, answer) {
  const query = shouldAppendSite(params) ? `${params.query} site:${params.site}` : params.query
  if (answer.results.length === 0) {
    return renderEmpty({ query, note: answer.note })
  }
  return renderResults({
    results: answer.results,
    total: Math.max(answer.total, answer.results.length),
    ms: answer.ms,
    cached: answer.cached,
  })
}
