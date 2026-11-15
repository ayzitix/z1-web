/**
 * Environment, HTTP and error plumbing shared by the web tools.
 *
 * Everything a tool needs that is not SearXNG-specific lives here, so a later
 * `web.fetch` can reuse it without touching `search.js`:
 *
 * - `searxBaseUrl()` / `timeoutMs()` read `Z1_SEARX_URL` (default
 *   `http://127.0.0.1:8888`) and `Z1_WEB_TIMEOUT_MS` (default 15000) once per
 *   call, so a long-lived worker sees an edited environment only after the
 *   host restarts it — the values are read fresh, not cached in a module
 *   constant that a test cannot change.
 * - `requestText()` is the only place that touches `ctx.net.request`. It adds
 *   the deadline (`AbortController` + `Promise.race`; the host also caps at
 *   30 s and 1 MiB) and turns every failure into one `WebError` with a `kind`
 *   of `unreachable`, `timeout`, `denied`, `http` or `invalid`, so callers
 *   write the user-facing sentence in one place instead of matching strings.
 * - `redactUrl()` strips `user:pass@` before a URL is logged, echoed in an
 *   error or shown in `web.status`. There are no credentials in a loopback
 *   SearXNG, but the module must not be the thing that prints them if someone
 *   points `Z1_SEARX_URL` at a password-protected instance.
 *
 * A refused connection or a DNS failure reaches a worker as a rejected
 * `ctx.net.request` (Node's `TypeError: fetch failed` with a `cause.code`), so
 * the classification below reads `err.cause` as well: the tool result should
 * say "start the container", never "fetch failed".
 *
 * @module z1-web/net
 */

export const DEFAULT_SEARX_URL = 'http://127.0.0.1:8888'
export const DEFAULT_TIMEOUT_MS = 15_000
/** The host aborts its own fetch at 30 s; asking for more cannot succeed. */
const MAX_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 250

/** The SearXNG base URL, trailing slashes removed and credentials intact. */
export function searxBaseUrl() {
  const raw = (process.env['Z1_SEARX_URL'] ?? '').trim()
  if (raw === '') return DEFAULT_SEARX_URL
  return raw.replace(/\/+$/, '')
}

/** `true` when the base URL came from the environment rather than the default. */
export function searxBaseUrlIsOverride() {
  return (process.env['Z1_SEARX_URL'] ?? '').trim() !== ''
}

/** The search deadline in milliseconds; out-of-range values fall back. */
export function timeoutMs() {
  return readTimeout(process.env['Z1_WEB_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS)
}

/** Parse a timeout, clamped to what the host can actually honour. */
export function readTimeout(raw, fallback) {
  if (raw === undefined || String(raw).trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

/**
 * Remove `user:pass@` from a URL for display. Returns the input unchanged when
 * it does not parse, so a broken value is still visible in an error message.
 */
export function redactUrl(url) {
  if (typeof url !== 'string') return String(url)
  try {
    const parsed = new URL(url)
    if (parsed.username === '' && parsed.password === '') return url
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return url.replace(/\/\/[^/@\s]*@/, '//')
  }
}

/** A failure with a machine-readable kind and, where relevant, a status. */
export class WebError extends Error {
  /**
   * @param {'unreachable'|'timeout'|'denied'|'http'|'invalid'} kind
   * @param {string} message
   * @param {{ status?: number, body?: string, cause?: unknown }} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message)
    this.name = 'WebError'
    this.kind = kind
    if (extra.status !== undefined) this.status = extra.status
    if (extra.body !== undefined) this.body = extra.body
    if (extra.cause !== undefined) this.cause = extra.cause
  }
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

function codeOf(error) {
  if (error === null || typeof error !== 'object') return undefined
  const code = error.code
  if (typeof code === 'string') return code
  return codeOf(error.cause)
}

/** True for the shapes a dead server or a bad hostname produces. */
function looksUnreachable(error) {
  if (codeOf(error) !== undefined && UNREACHABLE_CODES.has(codeOf(error))) return true
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|network|socket hang up|connect ECONN|getaddrinfo/i.test(message)) return true
  return error !== null && typeof error === 'object' && error.cause !== undefined && looksUnreachable(error.cause)
}

/** Classify anything `ctx.net.request` (or the deadline) can throw. */
export function toWebError(error) {
  if (error instanceof WebError) return error
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)

  if (name === 'AbortError' || name === 'TimeoutError') {
    return new WebError('timeout', 'the request was aborted by the host deadline', { cause: error })
  }
  if (/net\.request denied|not granted|not in the allowlist/i.test(message)) {
    return new WebError('denied', message, { cause: error })
  }
  if (looksUnreachable(error)) {
    return new WebError('unreachable', message, { cause: error })
  }
  return new WebError('invalid', message, { cause: error })
}

/**
 * GET a URL through the host broker and return the decoded body.
 *
 * The deadline races the broker call because `ctx.net.request` takes no
 * `signal`: the host's own 30 s abort still applies to the socket, and this
 * only decides when *we* stop waiting.
 *
 * @param {{ net: { request: (req: object) => Promise<object> } }} ctx
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeout?: number }} [options]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string, truncated: boolean, ms: number }>}
 */
export async function requestText(ctx, url, options = {}) {
  if (ctx === null || typeof ctx !== 'object' || ctx.net === undefined || typeof ctx.net.request !== 'function') {
    throw new WebError('invalid', 'ctx.net.request is not available in this worker')
  }
  const timeout = options.timeout ?? timeoutMs()
  const started = Date.now()
  let timer

  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new WebError('timeout', `no answer within ${timeout} ms`))
    }, timeout)
  })

  try {
    const response = await Promise.race([
      ctx.net.request({
        url,
        method: 'GET',
        headers: options.headers ?? {},
      }),
      deadline,
    ])
    if (response === null || typeof response !== 'object') {
      throw new WebError('invalid', 'ctx.net.request returned no response object')
    }
    const status = typeof response.status === 'number' ? response.status : 0
    const body = typeof response.body === 'string' ? response.body : ''
    return {
      status,
      headers: response.headers ?? {},
      body,
      truncated: response.truncated === true,
      ms: Date.now() - started,
    }
  } catch (error) {
    throw toWebError(error)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Look up a response header case-insensitively; the host preserves the wire
 * casing, which is not guaranteed to be lower-case.
 */
export function header(headers, name) {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return String(value)
  }
  return undefined
}
