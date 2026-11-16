/**
 * `web.status`: what state the web tools are in, in two lines.
 *
 * SearXNG is no longer started by this module or by a script in this
 * repository: the z1 CLI provisions a native backend on startup and installs
 * it on first run (~120 MB). A worker therefore cannot know "healthy" from
 * "coming up" by probing alone — a refused connection looks identical in both
 * cases. The host resolves that by exporting `Z1_SEARX_STATE` (`installing`,
 * `starting`, `up`, `down`) while it works, and this tool reports:
 *
 * - `healthy` when the probe answers 200 **and** an actual SearXNG body — the
 *   literal `OK` from `/healthz`, or a `/config` JSON payload mentioning
 *   searxng. A 200 alone proves nothing: a proxy, a dev server or a stale
 *   error page on port 8888 answers 200 too. A measurement beats a hint;
 * - `starting` when the probe failed and the host says it is installing or
 *   starting (optionally `starting:<epochMs>`, ignored after 2 minutes so a
 *   crash cannot leave the word `starting` stuck forever — the CLI's install is
 *   ~35 s and a worker's environment snapshot cannot update);
 * - `down` otherwise, with the one sentence that explains who starts it.
 *
 * The second line is the point of the tool when the backend is missing:
 * `stack.search` and `github.issues` are public APIs and work without it.
 *
 * It never throws and never prints a stack trace — a status tool that fails is
 * useless.
 *
 * @module z1-web/status
 */

import { renderStatus } from './format.js'
import { header, redactUrl, requestText, searxBaseUrl, searxBaseUrlIsOverride, timeoutMs, VERSION, WebError } from './net.js'
import { token } from './github.js'

/** A status line must not hang a worker. */
const STATUS_TIMEOUT_CAP_MS = 3000

/** How long a `starting` hint is believed without a live backend. */
const STARTING_TTL_MS = 2 * 60 * 1000

export const DOWN_HINT = 'z1 starts it on launch (first run installs ~120 MB)'
export const STARTING_HINT = 'z1 is installing or starting it (~120 MB on first run); retry in a few seconds'

/**
 * Read the host's provisioning hint: `{ phase, at }` where `phase` is
 * `installing`, `starting`, `up`, `down` or empty when the host said nothing.
 * Accepts `starting`, `starting:<epochMs>` and `starting@<isoDate>`.
 */
export function readProvisioningHint(env = process.env) {
  const raw = (env['Z1_SEARX_STATE'] ?? env['Z1_SEARX_STATUS'] ?? '').trim().toLowerCase()
  if (raw === '') return { phase: '' }
  const [name, stamp] = raw.split(/[:@]/, 2)
  const at = stamp === undefined ? undefined : /^\d+$/.test(stamp) ? Number(stamp) : Date.parse(stamp)
  return { phase: name, at: Number.isFinite(at) ? at : undefined }
}

/** `true` when the host hint is still fresh enough to believe. */
export function isProvisioning(hint, now = Date.now()) {
  if (hint.phase !== 'installing' && hint.phase !== 'starting' && hint.phase !== 'provisioning') return false
  if (hint.at === undefined) return true
  return now - hint.at <= STARTING_TTL_MS
}

/** `healthz` answers exactly this; anything else is not a SearXNG fingerprint. */
const HEALTHY_BODY = /^ok$/i

/** Does this body prove a SearXNG instance answered? */
export function hasSearxngFingerprint(body) {
  if (typeof body !== 'string') return false
  if (HEALTHY_BODY.test(body.trim())) return true
  if (!/\{/.test(body)) return false
  try {
    const data = JSON.parse(body)
    return data !== null && typeof data === 'object' && /searxng/i.test(JSON.stringify(data))
  } catch {
    return false
  }
}

/** One short reason for a failed probe; never a stack or a raw body. */
export function probeReason(error, timeout) {
  const web = error instanceof WebError ? error : null
  if (web?.kind === 'timeout') return `no answer within ${timeout} ms`
  if (web?.kind === 'denied') return 'refused by the host allowlist'
  if (web?.kind === 'unreachable') return 'connection refused'
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === '' ? 'no answer' : clipOneLine(message, 120)
}

function clipOneLine(text, max) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** `/config` is the fingerprint of last resort: every build answers it. */
async function probeConfig(ctx, base, timeout) {
  try {
    const response = await requestText(ctx, `${base}/config`, {
      headers: { accept: 'application/json', 'user-agent': `z1-web/${VERSION}` },
      timeout,
    })
    if (response.status === 200 && hasSearxngFingerprint(response.body)) {
      return { state: 'healthy', detail: `${response.ms} ms` }
    }
    return { state: 'unhealthy', detail: `HTTP ${response.status} from /config` }
  } catch (error) {
    return { state: 'unreachable', detail: probeReason(error, timeout) }
  }
}

/**
 * Probe the backend and return `{ state, detail }` where `state` is
 * `healthy`, `unhealthy` (it answered, but not as SearXNG) or `unreachable`,
 * and `detail` is the reason: `HTTP 500`, `no answer within 3000 ms`,
 * `connection refused`, or why a 200 is not SearXNG. A 200 with an HTML error
 * page is the common failure (a proxy or another service on port 8888), so a
 * status alone is never enough to call it healthy.
 */
export async function probe(ctx) {
  const base = searxBaseUrl()
  const timeout = Math.min(timeoutMs(), STATUS_TIMEOUT_CAP_MS)

  let response
  try {
    response = await requestText(ctx, `${base}/healthz`, {
      headers: { accept: 'text/plain,application/json', 'user-agent': `z1-web/${VERSION}` },
      timeout,
    })
  } catch (error) {
    return { state: 'unreachable', detail: probeReason(error, timeout) }
  }

  if (response.status === 200 && hasSearxngFingerprint(response.body)) {
    const type = header(response.headers, 'content-type')
    return { state: 'healthy', detail: `${response.ms} ms`, body: response.body, type }
  }
  if (response.status === 200) {
    const fallback = await probeConfig(ctx, base, timeout)
    if (fallback.state === 'healthy') return fallback
    return {
      state: 'unhealthy',
      detail: 'HTTP 200 but the body is not SearXNG (no OK from /healthz, no searxng in /config)',
    }
  }
  // A non-2xx `/healthz` can still be a SearXNG behind a proxy that owns that
  // path; `/config` decides instead of trusting the status.
  const fallback = await probeConfig(ctx, base, timeout)
  if (fallback.state === 'healthy') return fallback
  return { state: 'unhealthy', detail: `HTTP ${response.status}` }
}

/** `web.status`: two lines, never a stack trace. */
export async function runStatus(ctx) {
  const url = redactUrl(searxBaseUrl())
  const hint = readProvisioningHint()
  const probeResult = await probe(ctx)

  let state
  let detail
  if (probeResult.state === 'healthy') {
    state = 'healthy'
    detail = probeResult.detail
  } else if (isProvisioning(hint)) {
    state = 'starting'
    detail = STARTING_HINT
  } else if (probeResult.state === 'unhealthy') {
    state = 'unhealthy'
    detail = probeResult.detail
  } else {
    state = 'down'
    detail = `${probeResult.detail} · ${DOWN_HINT}`
  }

  return renderStatus({
    url,
    state,
    detail,
    override: searxBaseUrlIsOverride(),
    githubAuthed: token() !== undefined,
  })
}
