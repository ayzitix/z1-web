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
 * - `healthy` when `/healthz` answers 200, whatever the environment says: a
 *   measurement beats a hint;
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

/** Probe `/healthz` and return `{ state, detail }`. */
export async function probe(ctx) {
  const base = searxBaseUrl()
  const timeout = Math.min(timeoutMs(), STATUS_TIMEOUT_CAP_MS)

  try {
    const response = await requestText(ctx, `${base}/healthz`, {
      headers: { accept: 'text/plain', 'user-agent': `z1-web/${VERSION}` },
      timeout,
    })
    if (response.status === 200) {
      const type = header(response.headers, 'content-type')
      return { state: 'healthy', detail: `${response.ms} ms`, body: response.body, type }
    }
    return { state: 'unhealthy', detail: `HTTP ${response.status}` }
  } catch (error) {
    const web = error instanceof WebError ? error : null
    if (web?.kind === 'timeout') return { state: 'unreachable', detail: `no answer within ${timeout} ms` }
    if (web?.kind === 'denied') return { state: 'unreachable', detail: 'the host refused the request' }
    return { state: 'unreachable', detail: 'no answer' }
  }
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
  } else {
    state = 'down'
    detail = DOWN_HINT
  }

  return renderStatus({
    url,
    state,
    detail,
    override: searxBaseUrlIsOverride(),
    githubAuthed: token() !== undefined,
  })
}
