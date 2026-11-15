/**
 * `web.fetch`: read one page, return its text.
 *
 * This is the second half of the web stack. `web.search` returns 300-character
 * snippets, which is enough to choose a page and not enough to answer from it;
 * `web.fetch` turns a URL into readable text, a title and one footer line, so a
 * model can quote a docs page instead of guessing from a teaser.
 *
 * The pipeline is deliberately short, because the host already does the hard
 * security work:
 *
 * 1. **Validate locally.** `http`/`https` only, no `user:pass@`, no `file:`,
 *    `data:` or `ftp:`. A typo costs no request.
 * 2. **One request** through `ctx.net.request`. The host enforces the
 *    allowlist, refuses private/loopback/metadata targets unless the manifest
 *    grants them, follows up to five redirects re-checking every hop, decodes
 *    the charset and caps the body at 1 MiB. None of that is re-implemented
 *    here — a redirect is followed by the host, not by this file.
 * 3. **Route on `content-type`**, not on the URL: HTML is extracted, plain text
 *    and markdown pass through, JSON is pretty-printed, PDF and media are
 *    refused with the type and size named, and a missing header is sniffed.
 * 4. **Slice by character.** `offset` is 1-based and counts code points, never
 *    UTF-16 units, so a `maxChars` cut cannot split an emoji or a surrogate
 *    pair and `offset = previous end + 1` reconstructs the page exactly.
 *
 * Answers are cached for 10 minutes keyed by `(url, offset, maxChars)`, at most
 * 50 entries, successes only. A refusal, an error page or an empty body is
 * never cached, so a fixed login wall is retried rather than remembered.
 *
 * @module z1-web/fetch
 */

import { cacheKey as makeKey, createCache } from './cache.js'
import { charCount, extractHtml, slicePoints } from './html.js'
import { header, headerInt, redactUrl, requestText, timeoutMs, VERSION, WebError } from './net.js'

/** The `Accept` we send: HTML first, everything else allowed, cheap. */
export const ACCEPT = 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5'
export const ACCEPT_LANGUAGE = 'en-US,en;q=0.8'

export const DEFAULT_MAX_CHARS = 50_000
export const MIN_MAX_CHARS = 1000
export const MAX_MAX_CHARS = 100_000
const FIRST_OFFSET = 1

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 50

/** Successful answers: key -> { at, value }. */
const cache = createCache({ ttlMs: CACHE_TTL_MS, max: CACHE_MAX })

/** Test seam: empty the fetch cache. */
export function clearCache() {
  cache.clear()
}

/** Test/diagnostic seam: current cache occupancy. */
export function cacheSize() {
  return cache.size
}

function fail(message) {
  throw new Error(`web.fetch: ${message}`)
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Group digits with spaces: `84213` -> `84 213` (as the footer shows it). */
export function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/**
 * Validate and normalise the model's arguments.
 *
 * @param {unknown} raw
 * @returns {{ url: string, offset: number, maxChars: number }}
 */
export function readParams(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('expects an object of arguments')
  }

  const rawUrl = raw['url']
  if (rawUrl === undefined || rawUrl === null) fail('url is required')
  if (typeof rawUrl !== 'string') fail('url must be a string')
  const trimmed = rawUrl.trim()
  if (trimmed === '') fail('url must be a non-empty string')

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    fail(`url must be an absolute http(s) URL (got ${JSON.stringify(trimmed)})`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`only http and https can be fetched, not "${parsed.protocol.replace(/:$/, '')}"`)
  }
  if (parsed.hostname === '') fail(`url has no hostname (got ${JSON.stringify(trimmed)})`)
  if (parsed.username !== '' || parsed.password !== '') {
    fail('url must not contain credentials (user:pass@); remove them and use a public URL')
  }

  const offset = readInteger(raw['offset'], FIRST_OFFSET, FIRST_OFFSET, Number.MAX_SAFE_INTEGER, 'offset')
  const maxChars = readInteger(raw['maxChars'], DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS, 'maxChars')
  return { url: parsed.toString(), offset, maxChars }
}

function readInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${name} must be an integer from ${min} to ${max}`)
  }
  if (value < min || value > max) fail(`${name} must be an integer from ${min} to ${max}`)
  return value
}

// ---------------------------------------------------------------------------
// Content type
// ---------------------------------------------------------------------------

/** Mime type without parameters, lower-case. */
function mimeOf(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase()
}

/**
 * Choose a route from the `content-type`, or from the first bytes when the
 * header is missing (many static hosts omit it, and a raw HTML file served as
 * `application/octet-stream` is `octet-stream` all the same).
 *
 * @returns {'html'|'text'|'json'|'pdf'|'binary'|'other'}
 */
export function routeContentType(contentType, body) {
  const mime = mimeOf(contentType)
  if (mime === '') return sniff(body)
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'application/xhtml') return 'html'
  if (mime === 'text/plain' || mime === 'text/markdown' || mime === 'text/x-markdown') return 'text'
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) return 'binary'
  if (mime === 'application/octet-stream' || mime === 'application/zip' || mime === 'application/gzip') return 'binary'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/xml' || mime.endsWith('+xml')) return 'text'
  if (mime === 'application/javascript' || mime === 'application/x-javascript') return 'text'
  if (/[\u0000-\u0008\u000e-\u001f]/.test(body.slice(0, 4096))) return 'binary'
  return 'other'
}

/** Missing `content-type`: guess from the first non-space bytes. */
function sniff(body) {
  const head = body.slice(0, 512)
  if (/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(head)) return 'html'
  if (/^\s*[{[<]/.test(head)) {
    if (/^\s*</.test(head)) return 'text'
    return 'json'
  }
  return 'text'
}

// ---------------------------------------------------------------------------
// Request and errors
// ---------------------------------------------------------------------------

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  410: 'Gone',
  429: 'Too Many Requests',
  451: 'Unavailable For Legal Reasons',
}

function statusError(status, url, headers) {
  const reason = STATUS_TEXT[status] ?? ''
  const label = reason === '' ? `${status}` : `${status} ${reason}`
  if (status === 401 || status === 403) {
    return new Error(`web.fetch: ${label} (the page may require a login or block bots) — ${url}`)
  }
  if (status === 429) {
    const retry = header(headers, 'retry-after')
    const tail = retry === undefined || retry.trim() === '' ? '' : ` · Retry-After ${retry.trim()}`
    return new Error(`web.fetch: ${label}${tail} — ${url}`)
  }
  if (status >= 500) return new Error(`web.fetch: server error ${status} — ${url}`)
  return new Error(`web.fetch: ${label} — ${url}`)
}

/** One actionable line for anything `ctx.net.request` throws. */
function describeError(error, url, timeout) {
  const kind = error instanceof WebError ? error.kind : undefined
  const safe = redactUrl(url)

  if (kind === 'timeout') return new Error(`web.fetch: no answer within ${timeout} ms · ${safe}`)
  if (kind === 'unreachable') {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 160)
    return new Error(`web.fetch: cannot reach ${safe} · ${detail === '' ? 'the host is unreachable' : detail}`)
  }
  if (kind === 'denied') {
    // The host's own refusal text names the host and the reason; pass it
    // through instead of inventing a second explanation.
    return new Error(`web.fetch: ${error instanceof Error ? error.message : String(error)}`)
  }
  return new Error(`web.fetch: ${error instanceof Error ? error.message : String(error)}`)
}

/** Bytes as the host saw them: the header when present, else the string. */
function bodyBytes(response) {
  const declared = headerInt(response.headers, 'content-length')
  if (declared !== undefined && declared > 0) return declared
  return Buffer.byteLength(response.body, 'utf8')
}

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

/**
 * One rendered answer: optional title line, footer, blank line, text, then the
 * continuation line when the page is longer than `maxChars`.
 */
export function renderAnswer({ url, contentType, title, text, total, offset, maxChars, ms, cached, capped, sniffed }) {
  const type = sniffed ? `${contentType || '(no content-type)'} (sniffed)` : contentType
  const end = Math.min(total, offset - 1 + maxChars)
  const parts = [type, `${groupDigits(total)} chars`, `showing ${offset}–${end}`, `${ms} ms`, `cached: ${cached ? 'yes' : 'no'}`]
  if (capped) parts.push('body capped at 1 MiB')

  const shown = total === 0 ? '' : slicePoints(text, offset - 1, maxChars)
  const lines = []
  if (title !== '') lines.push(`${title} — ${url}`)
  lines.push(`(${parts.join(' · ')})`)
  lines.push('')
  lines.push(shown)
  if (end < total) {
    lines.push(`… (truncated at ${end} chars; call web.fetch with offset=${end + 1})`)
  }
  return lines.join('\n')
}

/** The "offset past the end" notice: informative, not an error, not cached. */
function pastEndAnswer({ url, contentType, title, total, offset, ms, capped, sniffed }) {
  const type = sniffed ? `${contentType} (sniffed)` : contentType
  const parts = [type, `${groupDigits(total)} chars`, 'offset past end', `${ms} ms`, 'cached: no']
  if (capped) parts.push('body capped at 1 MiB')
  const notice = `(offset ${offset} is past the end; this page has ${groupDigits(total)} chars — call web.fetch with offset=1)`
  const lines = []
  if (title !== '') lines.push(`${title} — ${url}`)
  lines.push(`(${parts.join(' · ')})`)
  lines.push('')
  lines.push(notice)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return the model-facing text. Throws one actionable line on
 * failure; refusals and errors are never cached.
 */
export async function runFetch(ctx, raw) {
  const params = readParams(raw)
  const key = makeKey(['fetch', params.url, params.offset, params.maxChars])

  const hit = cache.get(key)
  if (hit !== undefined) return renderAnswer({ ...hit, cached: true })

  const page = await loadPage(ctx, params)

  if (page.total < params.offset) return pastEndAnswer(page)

  cache.set(key, page)
  return renderAnswer({ ...page, cached: false })
}

/** One request plus routing, extraction and the numbers the footer needs. */
async function loadPage(ctx, params) {
  const timeout = timeoutMs()
  let response
  try {
    response = await requestText(ctx, params.url, {
      headers: {
        accept: ACCEPT,
        'accept-language': ACCEPT_LANGUAGE,
        'user-agent': `z1-web/${VERSION}`,
      },
      timeout,
    })
  } catch (error) {
    throw describeError(error, params.url, timeout)
  }

  // `requestText` reports the final URL when the SDK provides it (after
  // redirects); until then it is the URL that was requested.
  const finalUrl = typeof response.url === 'string' && response.url !== '' ? response.url : params.url
  if (response.status < 200 || response.status > 299) {
    throw statusError(response.status, finalUrl, response.headers)
  }

  // A UTF-8 BOM is an encoding signature, not content. Left in place it shows
  // up as a zero-width mark at the head of the answer (rfc-editor .txt files
  // start with one) and it defeats the `^\s*<` HTML sniff below.
  const body = typeof response.body === 'string' ? response.body.replace(/^\uFEFF/, '') : response.body

  const rawType = header(response.headers, 'content-type') ?? ''
  const kind = routeContentType(rawType, body)
  const sniffed = mimeOf(rawType) === ''
  const contentType = sniffed ? sniffName(kind) : mimeOf(rawType)

  if (kind === 'pdf') {
    throw new Error(
      `web.fetch: PDF is not supported yet (${groupDigits(bodyBytes(response))} bytes) · ` +
        `fetch the HTML version or a text mirror`,
    )
  }
  if (kind === 'binary') {
    throw new Error(`web.fetch: ${contentType} is not text (${groupDigits(bodyBytes(response))} bytes) — ${finalUrl}`)
  }

  let title = ''
  let text
  if (kind === 'html') {
    const extracted = extractHtml(body, finalUrl)
    title = extracted.title
    text = extracted.text
  } else if (kind === 'json') {
    text = prettyJson(body)
  } else {
    text = body
  }

  const total = charCount(text)
  if (total === 0) throw new Error(`web.fetch: (the page returned no text) — ${finalUrl}`)

  return {
    url: finalUrl,
    contentType,
    title,
    text,
    total,
    offset: params.offset,
    maxChars: params.maxChars,
    ms: response.ms,
    capped: response.truncated === true,
    sniffed,
  }
}

/** The label shown in the footer for a sniffed body. */
function sniffName(kind) {
  if (kind === 'html') return 'text/html'
  if (kind === 'json') return 'application/json'
  return 'text/plain'
}

/** Pretty-print JSON; a body that does not parse is shown as it arrived. */
function prettyJson(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}
