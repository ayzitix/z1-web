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

/**
 * One result: title, URL, then an indented snippet (omitted when empty).
 */
export function renderResult(result, index) {
  const title = clip(oneLine(result.title), TITLE_MAX) || '(untitled)'
  const lines = [`${index}. ${title} — ${result.url}`]
  const snippet = clip(oneLine(result.snippet ?? ''), SNIPPET_MAX)
  if (snippet !== '') lines.push(`   ${snippet}`)
  return lines.join('\n')
}

/**
 * Decode the handful of HTML entities Stack Exchange puts in titles. It
 * escapes `"` and `'` in question titles, so an undecoded title would render
 * as `&quot;`. Unknown entities are left visible rather than guessed at.
 */
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
])

export function decodeEntities(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? whole
  })
}

/** `2024-03-02` from epoch milliseconds or seconds; `undefined` when absent. */
export function isoDay(epoch) {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch <= 0) return undefined
  const ms = epoch > 1e12 ? epoch : epoch * 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString().slice(0, 10)
}

/** `12:34:56 UTC` for a quota reset header (epoch seconds). */
export function clockUtc(epoch) {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch <= 0) return undefined
  const ms = epoch > 1e12 ? epoch : epoch * 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return undefined
  return `${date.toISOString().slice(11, 19)} UTC`
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

// ---------------------------------------------------------------------------
// Stack Exchange and GitHub
// ---------------------------------------------------------------------------

/**
 * One question: title and link, then the facts a model needs to decide whether
 * the page is worth opening — score, answers, accepted flag, tags, date.
 *
 * ```
 * 1. How do I fix E0502? — https://stackoverflow.com/questions/1
 *    score 42 · 7 answers · accepted · tags: rust, borrow-checker · 2024-03-02
 * ```
 */
export function renderStackResult(result, index) {
  const title = clip(oneLine(decodeEntities(result.title)), TITLE_MAX) || '(untitled)'
  const lines = [`${index}. ${title} — ${result.link}`]
  const facts = [`score ${result.score}`]
  const answers = result.answers
  facts.push(`${answers} ${answers === 1 ? 'answer' : 'answers'}`)
  if (result.accepted === true) facts.push('accepted')
  const tags = Array.isArray(result.tags) ? result.tags.slice(0, 5) : []
  if (tags.length > 0) facts.push(`tags: ${tags.map((tag) => clip(oneLine(tag), 35)).join(', ')}`)
  if (result.date !== undefined) facts.push(result.date)
  lines.push(`   ${facts.join(' · ')}`)
  return lines.join('\n')
}

/**
 * The Stack Exchange answer plus its footer. `total` is the API's match count,
 * so the model can see that a `limit` of 8 is a slice of 1523; `quota` is what
 * the API reported, never a guess.
 */
export function renderStackResults({ site, results, total, quota, cached = false }) {
  const body = results.map((result, index) => renderStackResult(result, index + 1)).join('\n')
  const parts = [site, `${results.length} of ${total}`]
  if (quota !== undefined) parts.push(`quota ${quota}`)
  if (cached) parts.push('cached')
  const footer = `(${parts.join(' · ')})`
  return body === '' ? footer : `${body}\n${footer}`
}

/** Empty Stack Exchange answer: name the query, the site and what to change. */
export function renderStackEmpty({ query, site, quota, cached = false }) {
  const head = `(no questions for ${JSON.stringify(query)} on ${site}`
  const detail = ['try fewer tags', 'drop accepted', 'use a different site'].join(' · ')
  const tail = quota === undefined ? '' : ` · quota ${quota}`
  return `${head}; ${detail}${cached ? ' · cached' : ''}${tail})`
}

/**
 * One GitHub hit: title, URL, then repo, state, comments, last update and
 * number. Nothing is decoded as HTML: the API returns plain text titles.
 */
export function renderGithubResult(result, index) {
  const title = clip(oneLine(result.title), TITLE_MAX) || '(untitled)'
  const lines = [`${index}. ${title} — ${result.url}`]
  const facts = []
  if (result.repo !== undefined) facts.push(result.repo)
  facts.push(result.state)
  const comments = result.comments
  facts.push(`${comments} ${comments === 1 ? 'comment' : 'comments'}`)
  if (result.updated !== undefined) facts.push(`updated ${result.updated}`)
  if (result.number !== undefined) facts.push(`#${result.number}`)
  lines.push(`   ${facts.join(' · ')}`)
  return lines.join('\n')
}

/**
 * The GitHub answer plus its footer. The rate-limit pair comes from the
 * response headers, so `9/10` is what GitHub reported for the search resource
 * *after* this request was counted: it is what the next call may spend, and
 * `0/10` means that call will be refused until the reset minute.
 */
export function renderGithubResults({ results, total, remaining, rateLimit, cached = false, incomplete = false }) {
  const body = results.map((result, index) => renderGithubResult(result, index + 1)).join('\n')
  const parts = ['github', `${results.length} of ${total}`]
  if (remaining !== undefined && rateLimit !== undefined) parts.push(`${remaining}/${rateLimit} requests left this minute`)
  if (incomplete) parts.push('incomplete results')
  if (cached) parts.push('cached')
  const footer = `(${parts.join(' · ')})`
  return body === '' ? footer : `${body}\n${footer}`
}

/** Empty GitHub answer, with the two qualifiers most often at fault. */
export function renderGithubEmpty({ query, remaining, rateLimit, cached = false }) {
  const head = `(no issues for ${JSON.stringify(query)}`
  const detail = ['drop repo:', 'try state: all', 'shorten the keywords'].join(' · ')
  const tail = remaining !== undefined && rateLimit !== undefined
    ? ` · ${remaining}/${rateLimit} requests left this minute`
    : ''
  return `${head}; ${detail}${cached ? ' · cached' : ''}${tail})`
}

/**
 * `web.status`: two lines, never a stack trace.
 *
 * The first line is the SearXNG backend — `healthy`, `starting` while z1 is
 * installing or launching it, `down` otherwise. The second says that the two
 * public-API tools need no backend at all, which is the useful thing to know
 * when the backend is missing: search still works.
 */
export function renderStatus({ url, state, detail, override = false, githubAuthed = false }) {
  const first = ['searxng', url, state]
  if (detail !== undefined && detail !== '') first.push(detail)

  const quota = githubAuthed ? 'GitHub 30/min with Z1_GITHUB_TOKEN' : 'GitHub 10/min anonymous'
  const second = [
    'stack.search · github.issues · keyless · available',
    `(Stack Exchange 300/day per IP · ${quota})`,
  ]
  if (override) second.push('Z1_SEARX_URL override')
  return `${first.join(' · ')}\n${second.join(' ')}`
}

