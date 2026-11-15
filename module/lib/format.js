/**
 * Model-facing rendering: numbered text, never JSON.
 *
 * A search costs tokens in proportion to its output, so the record is three
 * lines at most and the footer is one short parenthetical:
 *
 * ```
 * 1. TypeScript: JavaScript With Syntax For Types. — https://www.typescriptlang.org/
 *    TypeScript is a strongly typed programming language that builds on JavaScript…
 * (searxng · 8 of 46 results · 132 ms · cached)
 * ```
 *
 * Rules that matter to a model reading this:
 *
 * - Titles are clipped to 160 characters and snippets to 300, on code-point
 *   boundaries (a surrogate pair is never split), with `…` marking a cut.
 *   Snippets collapse to one line: a newline inside a snippet would look like
 *   a new result and break the numbering.
 * - Control characters, bidi overrides and zero-width marks from a scraped
 *   page are escaped or removed, so a hostile result cannot rewrite the output
 *   around it.
 * - Results are untrusted text. Nothing here executes or follows them, and the
 *   tool description says so; the renderer's job is only to keep them inert.
 *
 * @module z1-web/format
 */

const TITLE_MAX = 160
const SNIPPET_MAX = 300

/** C0/C1 controls, bidi overrides and zero-width marks that can rewrite a line. */
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Replace unsafe marks with a visible escape or nothing. */
export function sanitise(text) {
  if (typeof text !== 'string') return ''
  return text.replace(UNSAFE, (char) => {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return ''
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
}

/** Flatten to one line: paragraphs, tabs and repeated spaces become one space. */
export function oneLine(text) {
  return sanitise(text).replace(/\s+/g, ' ').trim()
}

/**
 * Clip to `max` characters (counting code points, so an emoji or a combining
 * sequence is not cut mid-pair) and mark the cut with `…`. The ellipsis is
 * inside the budget, so the result is never longer than `max`.
 */
export function clip(text, max) {
  const points = Array.from(text)
  if (points.length <= max) return text
  const cut = points.slice(0, Math.max(0, max - 1)).join('').replace(/\s+$/, '')
  return `${cut}…`
}

/** One result: title, URL, then an indented snippet (omitted when empty). */
export function renderResult(result, index) {
  const title = clip(oneLine(result.title), TITLE_MAX) || '(untitled)'
  const lines = [`${index}. ${title} — ${result.url}`]
  const snippet = clip(oneLine(result.snippet ?? ''), SNIPPET_MAX)
  if (snippet !== '') lines.push(`   ${snippet}`)
  return lines.join('\n')
}

/**
 * The whole result list plus its footer. `total` is how many results SearXNG
 * returned before de-duplication, `site` filtering and `count` clipping, so
 * the footer tells the model whether it is seeing a slice.
 */
export function renderResults({ results, total, ms, cached = false }) {
  const body = results.map((result, index) => renderResult(result, index + 1)).join('\n')
  const parts = ['searxng', `${results.length} of ${total} results`, `${ms} ms`]
  if (cached) parts.push('cached')
  const footer = `(${parts.join(' · ')})`
  return body === '' ? footer : `${body}\n${footer}`
}

/**
 * The empty answer. It names the query, so the model can see what was actually
 * sent (including an appended `site:`), and it lists the three moves that
 * usually help instead of leaving the model to retry blindly.
 */
export function renderEmpty({ query, note }) {
  const head = `(no results for ${JSON.stringify(query)}`
  const hint = 'try shorter keywords, drop site:/recency, or fetch a known URL'
  if (note !== undefined && note !== '') return `${head}; ${note} · ${hint})`
  return `${head}; ${hint})`
}

/** `web.status`: two lines, never a stack trace. */
export function renderStatus({ url, state, detail, override, envTimeout, fetchState }) {
  const line = [`searxng`, url, state]
  if (detail !== undefined && detail !== '') line.push(detail)
  line.push('default provider', 'fallbacks: none configured')
  const second = []
  second.push(override ? `Z1_SEARX_URL=${url} (override)` : 'Z1_SEARX_URL not set (default)')
  if (envTimeout !== undefined) second.push(`Z1_WEB_TIMEOUT_MS=${envTimeout}`)
  second.push(fetchState)
  return `${line.join(' · ')}\n${second.join(' · ')}`
}
