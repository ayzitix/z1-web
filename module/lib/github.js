/**
 * `github.issues`: GitHub's issue/PR search, rendered as a short list.
 *
 * One GET to `https://api.github.com/search/issues`. The API is anonymous by
 * default and allows **10 search requests a minute**; with a token set
 * (`Z1_GITHUB_TOKEN`, or `GITHUB_TOKEN` as a local fallback) it is 30. That is
 * a far tighter budget than most models assume, so the
 * footer says exactly how many requests are left in the current minute (from
 * `x-ratelimit-remaining` / `x-ratelimit-limit`, which GitHub scopes to the
 * `search` resource) and answers are cached for five minutes.
 *
 * Qualifiers are built here, not left to the model: `repo:owner/name` is
 * prepended and `state:` / `is:issue` / `is:pr` are appended, deduplicated,
 * and the built `q` is checked against GitHub's 256-character limit *before*
 * the request — a 422 costs one of the ten calls. GitHub caps a query at five
 * operators, so the tool never adds more than three.
 *
 * The qualifiers this tool owns — `repo:`, `state:`, `is:`, `user:`, `org:` and
 * `label:` — are **removed from the model's `query`** before the request. Left
 * in, they would arrive after ours (`repo:a/b boom repo:evil/x state:closed`)
 * and a repeated qualifier either widens the search or earns a 422. Stripping
 * is silent and documented: the arguments `repo`/`state`/`kind` are the way to
 * express those filters, so the words that remain are the user's keywords.
 *
 * `sort` is omitted for `relevance`: GitHub documents `created`, `updated` and
 * `comments` and treats anything else as best match, so sending the literal
 * string would be noise in the URL and a validation risk if GitHub tightens
 * up. The observable order is the same.
 *
 * The token, when present, is only ever put in an `Authorization` header. It
 * is never echoed, never part of a cache key and never logged; a 401 says the
 * token was rejected, not what it was.
 *
 * @module z1-web/github
 */

import { cacheKey, createCache } from './cache.js'
import { renderGithubEmpty, renderGithubResults, isoDay, oneLine } from './format.js'
import { bodyMessage, headerInt, requestJson, toWebError, VERSION, timeoutMs, WebError } from './net.js'

export const API = 'https://api.github.com'

const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX = 50
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
/** GitHub rejects `q` longer than this. */
const MAX_QUERY_LENGTH = 256
const MAX_INPUT_QUERY = 500

/**
 * A qualifier the tool owns, as it can appear in free text: at the start, after
 * whitespace or an opening bracket, optionally negated, with a bare or quoted
 * value. `repo:rust-lang/rust` and `state:"closed"` both go; so does `-is:pr`.
 */
const OWNED_QUALIFIER = /(?:^|[\s(])[-+]?(?:repo|state|is|user|org|label):(?:"[^"]*"|'[^']*'|\S+)/gi

const STATES = new Set(['open', 'closed', 'all'])
const KINDS = new Set(['issue', 'pr', 'any'])
const SORTS = new Set(['relevance', 'created', 'updated', 'comments'])

/** `owner/name`; GitHub allows dots, dashes and underscores in both parts. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

const cache = createCache({ ttlMs: CACHE_TTL_MS, max: CACHE_MAX })

/** Test seam: empty the answer cache. */
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
  throw new Error(`github.issues: ${message}`)
}

/** Validate raw model arguments and build the final search query. */
export function readParams(raw) {
  if (raw === undefined || raw === null) fail('query is required')
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('expects an object of arguments')

  const rawQuery = raw['query']
  if (rawQuery === undefined || rawQuery === null) fail('query is required')
  if (typeof rawQuery !== 'string') fail('query must be a non-empty string')
  if (rawQuery.trim() === '') fail('query must be a non-empty string')
  if (rawQuery.length > MAX_INPUT_QUERY) fail(`query is longer than ${MAX_INPUT_QUERY} characters; shorten it`)
  // The tool owns repo:/state:/is:/user:/org:/label:; a copy typed into the
  // words would be appended after ours and could widen or break the search.
  const query = stripQualifiers(rawQuery)
  if (query === '') fail('query must contain keywords, not only repo:/state:/is: qualifiers')

  let repo
  if (raw['repo'] !== undefined && raw['repo'] !== null) {
    if (typeof raw['repo'] !== 'string') fail('repo must look like owner/name')
    repo = raw['repo'].trim()
    if (!REPO_PATTERN.test(repo)) fail(`repo must look like owner/name (got ${JSON.stringify(raw['repo'])})`)
  }

  let state = 'open'
  if (raw['state'] !== undefined && raw['state'] !== null) {
    if (typeof raw['state'] !== 'string' || !STATES.has(raw['state'])) fail('state must be open, closed or all')
    state = raw['state']
  }

  let kind = 'issue'
  if (raw['kind'] !== undefined && raw['kind'] !== null) {
    if (typeof raw['kind'] !== 'string' || !KINDS.has(raw['kind'])) fail('kind must be issue, pr or any')
    kind = raw['kind']
  }

  let sort = 'relevance'
  if (raw['sort'] !== undefined && raw['sort'] !== null) {
    if (typeof raw['sort'] !== 'string' || !SORTS.has(raw['sort'])) {
      fail('sort must be one of relevance, created, updated, comments')
    }
    sort = raw['sort']
  }

  const limit = readLimit(raw['limit'])
  const q = buildQuery({ query, repo, state, kind })
  if (q.length > MAX_QUERY_LENGTH) {
    fail(
      `the built query is ${q.length} characters; GitHub allows ${MAX_QUERY_LENGTH} ` +
        `(query, repo: and state:/is: qualifiers together) · shorten the keywords`,
    )
  }

  return { query, repo, state, kind, sort, limit, q }
}

/**
 * Drop the qualifiers this tool controls from the model's words and collapse
 * what is left to one line. A qualifier that is the whole query leaves nothing,
 * which `readParams` reports rather than sending `state:open is:issue` alone.
 */
export function stripQualifiers(query) {
  return oneLine(query.replace(OWNED_QUALIFIER, ' '))
}

/** GitHub's `q`: repo first, then the user's words, then state and kind. */
export function buildQuery({ query, repo, state, kind }) {
  const parts = []
  if (repo !== undefined) parts.push(`repo:${repo}`)
  const words = stripQualifiers(query)
  if (words !== '') parts.push(words)
  if (state !== 'all') parts.push(`state:${state}`)
  if (kind === 'issue') parts.push('is:issue')
  if (kind === 'pr') parts.push('is:pr')
  return parts.join(' ')
}

function readLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(number) || number < 1 || number > MAX_LIMIT) {
    fail(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  return number
}

/**
 * Which environment variable supplied the token: `Z1_GITHUB_TOKEN` or
 * `GITHUB_TOKEN`, `undefined` when neither is set. The 401 message names the
 * variable that was actually in effect instead of listing both.
 */
export function tokenSource() {
  if ((process.env['Z1_GITHUB_TOKEN'] ?? '').trim() !== '') return 'Z1_GITHUB_TOKEN'
  if ((process.env['GITHUB_TOKEN'] ?? '').trim() !== '') return 'GITHUB_TOKEN'
  return undefined
}

/**
 * The token, or `undefined`. `Z1_GITHUB_TOKEN` wins because that is the only
 * name the host passes into a worker's environment; `GITHUB_TOKEN` stays a
 * fallback for local/native runs. Never include either value in a message or a
 * cache key.
 */
export function token() {
  const name = tokenSource()
  if (name === undefined) return undefined
  const value = (process.env[name] ?? '').trim()
  return value === '' ? undefined : value
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** The search URL; `sort` is sent only for the three GitHub documents. */
export function issuesUrl(params, base = API) {
  const url = new URL(`${base}/search/issues`)
  url.searchParams.set('q', params.q)
  if (params.sort !== 'relevance') url.searchParams.set('sort', params.sort)
  url.searchParams.set('order', 'desc')
  url.searchParams.set('per_page', String(params.limit))
  return url.toString()
}

function rateHint(auth) {
  return auth ? '30/min with a GitHub token' : '10/min anonymous · set Z1_GITHUB_TOKEN for 30/min'
}

async function fetchIssues(ctx, params) {
  const url = issuesUrl(params)
  const timeout = timeoutMs()
  const auth = token()
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': `z1-web/${VERSION}`,
    'x-github-api-version': '2022-11-28',
  }
  if (auth !== undefined) headers.authorization = `Bearer ${auth}`

  let response
  try {
    response = await requestJson(ctx, url, { headers, timeout })
  } catch (error) {
    const web = error instanceof WebError ? error : toWebError(error)
    if (web.kind === 'timeout') fail(`GitHub did not answer within ${timeout} ms`)
    if (web.kind === 'denied') fail(`the host refused the request to api.github.com · ${web.message}`)
    fail('GitHub is unreachable · check the network, or retry in a moment')
  }

  const message = bodyMessage(response.body)
  const remaining = headerInt(response.headers, 'x-ratelimit-remaining')
  const rateLimit = headerInt(response.headers, 'x-ratelimit-limit')
  const reset = headerInt(response.headers, 'x-ratelimit-reset')

  if (response.status === 401) {
    const sent = tokenSource()
    if (sent === undefined) fail('GitHub answered HTTP 401 (no token was sent) · retry later')
    fail(`GitHub rejected ${sent} (HTTP 401) · unset or replace it; anonymous search still works`)
  }
  if (response.status === 403) {
    if (remaining === 0) {
      const when = reset === undefined ? '' : ` at ${new Date(reset * 1000).toISOString().slice(11, 19)} UTC`
      fail(
        `GitHub rate limit reached · the search quota resets${when} · ${rateHint(auth !== undefined)} ` +
          '(answers are cached for 5 minutes)',
      )
    }
    fail(`GitHub refused the request (HTTP 403${message === '' ? '' : ` · ${message}`}) · ${rateHint(auth !== undefined)}`)
  }
  if (response.status === 422) {
    const detail = firstError(response.body)
    const head = message === '' ? 'validation failed' : message
    fail(
      `GitHub rejected the query · ${head}${detail === '' ? '' : `: ${detail}`} · ` +
        'check repo:, state: and the keywords',
    )
  }
  if (response.status !== 200) {
    fail(`GitHub answered HTTP ${response.status}${message === '' ? '' : ` · ${message}`} · retry later`)
  }
  if (response.json !== true || response.data === null || typeof response.data !== 'object') {
    fail('GitHub returned a body that is not a JSON object · retry later')
  }
  return { data: response.data, ms: response.ms, remaining, rateLimit }
}

/** `errors[0].message` from a 422 body; GitHub puts the useful text there. */
function firstError(body) {
  try {
    const parsed = JSON.parse(body)
    const errors = parsed?.errors
    if (Array.isArray(errors) && typeof errors[0]?.message === 'string') {
      return errors[0].message.replace(/\s+/g, ' ').trim().slice(0, 180)
    }
  } catch {
    // Fall through: the top-level message is already in hand.
  }
  return ''
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** `https://api.github.com/repos/owner/name` → `owner/name`. */
function repoOf(item) {
  const raw = typeof item.repository_url === 'string' ? item.repository_url : ''
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(raw)
  return match === null ? undefined : match[1]
}

export function normaliseItems(items, limit) {
  const list = Array.isArray(items) ? items : []
  const results = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.html_url !== 'string' || !/^https:\/\/github\.com\//i.test(item.html_url)) continue
    if (typeof item.title !== 'string' || item.title.trim() === '') continue

    const record = {
      title: oneLine(item.title),
      url: item.html_url,
      state: item.state === 'closed' ? 'closed' : 'open',
      comments: Number.isFinite(item.comments) ? Math.trunc(item.comments) : 0,
    }
    const repo = repoOf(item)
    if (repo !== undefined) record.repo = repo
    const updated = isoDay(Date.parse(item.updated_at))
    if (updated !== undefined) record.updated = updated
    if (Number.isFinite(item.number)) record.number = Math.trunc(item.number)
    results.push(record)
    if (limit !== undefined && results.length >= limit) break
  }
  return results
}

function keyOf(params) {
  return cacheKey([
    'github',
    params.q,
    params.sort,
    params.limit,
    params.state,
    params.kind,
    params.repo ?? '',
  ])
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run one GitHub issue search and return the model-facing text. */
export async function runGithubIssues(ctx, raw) {
  const params = readParams(raw)

  const cached = cache.get(keyOf(params))
  if (cached !== undefined) return renderAnswer(params, { ...cached, cached: true })

  const response = await fetchIssues(ctx, params)
  const results = normaliseItems(response.data.items, params.limit)
  const rawTotal = Number.isFinite(response.data.total_count) ? Math.trunc(response.data.total_count) : results.length
  const value = {
    results,
    total: Math.max(rawTotal, results.length),
    remaining: response.remaining,
    rateLimit: response.rateLimit,
    incomplete: response.data.incomplete_results === true,
  }

  cache.set(keyOf(params), value)
  return renderAnswer(params, { ...value, cached: false })
}

function renderAnswer(params, answer) {
  if (answer.results.length === 0) {
    return renderGithubEmpty({
      query: params.q,
      remaining: answer.remaining,
      rateLimit: answer.rateLimit,
      cached: answer.cached,
    })
  }
  return renderGithubResults({
    results: answer.results,
    total: answer.total,
    remaining: answer.remaining,
    rateLimit: answer.rateLimit,
    incomplete: answer.incomplete === true,
    cached: answer.cached,
  })
}
