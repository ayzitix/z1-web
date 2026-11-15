/**
 * HTML → markdown-ish text, dependency-free and pure.
 *
 * `extractHtml(html, baseUrl)` is the only entry point the fetch tool needs;
 * everything else is exported so the extractor can be unit-tested without a
 * socket. There is no DOM, no parser package and no `node:html` API in Node 22,
 * so this is a tolerant tree builder plus a renderer:
 *
 * - the tree builder never throws. Unknown tags are kept as elements, stray
 *   end tags are ignored, unclosed elements are closed implicitly (`<p>`,
 *   `<li>`, `<td>`, `<tr>`, `<dt>`, `<dd>`, `<option>`). `<script>`, `<style>`,
 *   `<textarea>` and `<title>` are consumed as raw text up to their own end
 *   tag, so JavaScript containing `<` cannot corrupt the tree.
 * - the renderer emits blocks (headings, paragraphs, list lines, quotes,
 *   tables, fenced code) and joins them with exactly one blank line. Inline
 *   whitespace is collapsed; whitespace inside `<pre>` is not touched, because
 *   indentation is the content there.
 * - every character that reaches the output is either decoded entity text or
 *   markup this module generated. A source `<div class=x>` can never appear in
 *   the answer, and an entity-authored `&lt;div&gt;` is data, not a tag.
 *
 * Region selection is deliberate: `[role=main]` first, then `<main>`, then
 * `<article>`, then a handful of known ids/classes, then `<body>`. Navigation,
 * headers, footers, asides, forms and scripts are dropped wherever they appear,
 * so a docs page yields its prose and not its chrome. A page whose *whole*
 * body sits in a chrome-looking container (`class="menu"`) is re-rendered with
 * the filter off rather than reported as empty.
 *
 * @module z1-web/html
 */

import { clip, oneLine, sanitise, TITLE_MAX } from './format.js'

/**
 * How deep the tree may be, and how deep every walk over it may go. A real
 * document is a few dozen elements deep; a hostile one can be 60 000 nested
 * `<div>`s or 5 000 unclosed `<b>`s, which turns a careless recursive walker
 * into `RangeError: Maximum call stack size exceeded` out of a tool. Past this
 * budget the markup stops being structure: the element is not created, so its
 * text joins the deepest element that is inside the budget, and every walker
 * additionally treats a node at the limit as a leaf.
 */
export const MAX_DEPTH = 512

/** Elements that never have children in the source. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements whose content is text, not markup, up to the matching end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

/** Subtrees that never contribute text to the answer. */
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form',
  'button', 'nav', 'header', 'footer', 'aside', 'head', 'title', 'link',
  'meta', 'base',
])

/** Elements that start a new block even when they sit inside a paragraph. */
const BLOCK = new Set([
  'address', 'article', 'blockquote', 'body', 'center', 'dd', 'details',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'li', 'main', 'menu', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** Named entities that actually show up in documentation pages. */
const ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', '\u00a0'], ['ensp', '\u2002'], ['emsp', '\u2003'], ['thinsp', '\u2009'],
  ['shy', ''], ['zwnj', ''], ['zwj', ''],
  ['copy', '©'], ['reg', '®'], ['trade', '™'], ['deg', '°'],
  ['hellip', '…'], ['mdash', '—'], ['ndash', '–'], ['minus', '−'],
  ['lsquo', '‘'], ['rsquo', '’'], ['sbquo', '‚'],
  ['ldquo', '“'], ['rdquo', '”'], ['bdquo', '„'],
  ['laquo', '«'], ['raquo', '»'], ['lsaquo', '‹'], ['rsaquo', '›'],
  ['middot', '·'], ['bull', '•'], ['dagger', '†'], ['Dagger', '‡'],
  ['sect', '§'], ['para', '¶'], ['permil', '‰'], ['prime', '′'], ['Prime', '″'],
  ['plusmn', '±'], ['times', '×'], ['divide', '÷'], ['frac12', '½'],
  ['frac14', '¼'], ['frac34', '¾'], ['sup2', '²'], ['sup3', '³'], ['micro', 'µ'],
  ['cent', '¢'], ['pound', '£'], ['euro', '€'], ['yen', '¥'], ['curren', '¤'],
  ['larr', '←'], ['rarr', '→'], ['uarr', '↑'], ['darr', '↓'], ['harr', '↔'],
  ['le', '≤'], ['ge', '≥'], ['ne', '≠'], ['asymp', '≈'], ['infin', '∞'],
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['pi', 'π'],
  ['sigma', 'σ'], ['omega', 'ω'], ['mu', 'μ'], ['lambda', 'λ'], ['theta', 'θ'],
])

/** The legacy names browsers decode even without a semicolon. */
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp'])

/**
 * Decode the entity forms a page may use: the named set above, decimal
 * `&#39;` and hex `&#x2014;`, with or without the trailing semicolon.
 *
 * A missing semicolon is only accepted for the legacy five and only when the
 * next character cannot be part of a name, so a query string like
 * `?a=1&copy=2` keeps its `&copy` instead of becoming `©=2`.
 */
export function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text ?? ''
  return text.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (whole, body, offset, all) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X'
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
        if (code >= 0xd800 && code <= 0xdfff) return whole
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      const lower = body.toLowerCase()
      const named = ENTITIES.get(body) ?? ENTITIES.get(lower)
      if (named === undefined) return whole
      if (!whole.endsWith(';')) {
        if (!LEGACY.has(lower)) return whole
        const next = all[offset + whole.length]
        if (next !== undefined && /[a-zA-Z0-9=]/.test(next)) return whole
      }
      return named
    },
  )
}

// ---------------------------------------------------------------------------
// Tokenizer and tree builder
// ---------------------------------------------------------------------------

/** Parse the attributes of a start tag; unquoted values and bare names work. */
function parseAttrs(text) {
  const attrs = {}
  const re = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g
  let match
  while ((match = re.exec(text)) !== null) {
    const name = match[1].toLowerCase()
    let value = match[2] ?? ''
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1)
    if (!(name in attrs)) attrs[name] = decodeEntities(value)
  }
  return attrs
}

/** Read one tag at `start`; `null` when `<` is not a tag (e.g. `a < b`). */
function readTag(html, start) {
  let i = start + 1
  let closing = false
  if (html[i] === '/') {
    closing = true
    i += 1
  }
  const nameStart = i
  while (i < html.length && /[a-zA-Z0-9:_-]/.test(html[i])) i += 1
  const name = html.slice(nameStart, i).toLowerCase()
  if (name === '') return null
  const attrStart = i
  let quote = null
  while (i < html.length) {
    const ch = html[i]
    if (quote !== null) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      break
    }
    i += 1
  }
  return {
    closing,
    name,
    attrs: closing ? {} : parseAttrs(html.slice(attrStart, i)),
    end: i < html.length ? i + 1 : html.length,
  }
}

/** Index of the `</name` that ends a raw-text element, or `-1`. */
function rawEnd(html, from, name) {
  const re = new RegExp(`</${name}(?=[\\s/>])`, 'gi')
  re.lastIndex = from
  const match = re.exec(html)
  return match === null ? -1 : match.index
}

function appendText(parent, value) {
  if (value === '') return
  const last = parent.children[parent.children.length - 1]
  if (last !== undefined && last.type === 'text') last.value += value
  else parent.children.push({ type: 'text', value })
}

/** Implied end tags: the tags browsers auto-close before a sibling opens. */
function implyClose(stack, name) {
  const top = () => stack[stack.length - 1]
  if (name === 'p' || BLOCK.has(name)) {
    while (stack.length > 1 && top().name === 'p') stack.pop()
  }
  if (name === 'li') {
    while (stack.length > 1) {
      const open = top().name
      if (open === 'li') {
        stack.pop()
        break
      }
      if (open === 'ul' || open === 'ol' || open === 'menu' || open === 'table' || open === '#root') break
      stack.pop()
    }
  }
  if (name === 'dt' || name === 'dd') {
    while (stack.length > 1 && (top().name === 'dt' || top().name === 'dd')) stack.pop()
  }
  if (name === 'td' || name === 'th') {
    while (stack.length > 1 && (top().name === 'td' || top().name === 'th')) stack.pop()
  }
  if (name === 'tr') {
    while (stack.length > 1 && ['td', 'th', 'tr'].includes(top().name)) stack.pop()
  }
  if (name === 'option') {
    while (stack.length > 1 && top().name === 'option') stack.pop()
  }
}

function buildTree(html) {
  const root = { type: 'el', name: '#root', attrs: {}, children: [], depth: 0 }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  let i = 0

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      appendText(top(), html.slice(i))
      break
    }
    if (lt > i) appendText(top(), html.slice(i, lt))

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt)
      if (end !== -1) appendText(top(), html.slice(lt + 9, end))
      i = end === -1 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      i = end === -1 ? html.length : end + 1
      continue
    }

    const tag = readTag(html, lt)
    if (tag === null) {
      appendText(top(), '<')
      i = lt + 1
      continue
    }
    i = tag.end

    if (tag.closing) {
      for (let k = stack.length - 1; k >= 1; k -= 1) {
        if (stack[k].name === tag.name) {
          stack.length = k
          break
        }
      }
      continue
    }

    implyClose(stack, tag.name)
    if (tag.name === 'html' && stack.some((el) => el.name === 'html')) continue
    if (tag.name === 'body' && stack.some((el) => el.name === 'body')) continue

    const depth = top().depth + 1
    if (depth > MAX_DEPTH) {
      // Past the budget this tag is not structure, only a label: do not create
      // the element, so its text lands in the deepest element inside the
      // budget. Raw-text elements still have to be consumed as text or their
      // source (`<script>`) would leak into the answer as prose.
      if (RAW_TEXT.has(tag.name)) {
        const close = rawEnd(html, i, tag.name)
        if (close === -1) {
          i = html.length
        } else {
          const closing = readTag(html, close)
          i = closing === null ? html.length : closing.end
        }
      }
      continue
    }

    const element = { type: 'el', name: tag.name, attrs: tag.attrs, children: [], depth }
    top().children.push(element)
    if (VOID.has(tag.name)) continue

    stack.push(element)
    if (RAW_TEXT.has(tag.name)) {
      const close = rawEnd(html, i, tag.name)
      const raw = close === -1 ? html.slice(i) : html.slice(i, close)
      if (raw !== '') element.children.push({ type: 'text', value: raw })
      if (close === -1) {
        i = html.length
      } else {
        const closing = readTag(html, close)
        i = closing === null ? html.length : closing.end
      }
      stack.pop()
    }
  }

  return root
}

// ---------------------------------------------------------------------------
// Tree queries
// ---------------------------------------------------------------------------

/** A node's own depth in the built tree; 0 when it was never recorded. */
function depthOf(node) {
  return typeof node.depth === 'number' ? node.depth : 0
}

/**
 * The text directly inside a node, without descending. Used at the depth limit:
 * it keeps the words a page buried a thousand tags down while guaranteeing the
 * walk stops.
 */
function shallowText(node) {
  if (node.type === 'text') return decodeEntities(node.value)
  let text = ''
  for (const child of node.children ?? []) {
    if (child.type === 'text') text += decodeEntities(child.value)
  }
  return text
}

/** Depth-first search for the first element with `name`. */
function findElement(node, name, depth = depthOf(node)) {
  if (depth > MAX_DEPTH) return undefined
  for (const child of node.children ?? []) {
    if (child.type !== 'el') continue
    if (child.name === name) return child
    const found = findElement(child, name, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** All text under a node, whitespace preserved, entities decoded. */
function rawText(node, depth = depthOf(node)) {
  if (node.type === 'text') return decodeEntities(node.value)
  if (node.type !== 'el') return ''
  if (depth >= MAX_DEPTH) return shallowText(node)
  let text = ''
  for (const child of node.children) {
    if (child.type === 'el') {
      if (DROP.has(child.name)) continue
      if (child.name === 'br') {
        text += '\n'
        continue
      }
    }
    text += rawText(child, depth + 1)
  }
  return text
}

/** Collapse every run of whitespace to one space and trim. */
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** `role` values that mark navigation chrome rather than page content. */
const ROLE_CHROME = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search'])

/**
 * `id` / `class` tokens that name navigation chrome. A token has to be the
 * whole word or dash/underscore separated, so `nav-documentation` and
 * `sphinxsidebar`-style compound names are judged on their own tokens and
 * `navigation` itself is left to `role`.
 */
const CHROME_TOKEN = /(?:^|[-_])(?:sidebar|toc|breadcrumb|navbar|masthead|site-?nav|menu|nav)(?:[-_]|$)/i

function roleTokens(node) {
  const role = typeof node.attrs?.role === 'string' ? node.attrs.role : ''
  return role.toLowerCase().split(/\s+/).filter((token) => token !== '')
}

/**
 * `true` when an element is navigation chrome and its text should not reach the
 * answer. The chosen region and anything more specific than it (a `<pre>`, a
 * `<code>`, or a `role=main` subtree) is never dropped, so a page that wraps
 * its article in `class="doc-content nav-layout"` still keeps the article.
 *
 * `chrome = false` keeps only the unconditional drops (`<script>`, `<head>` …)
 * and turns the heuristic off; `extractHtml` uses that to re-read a region the
 * heuristic emptied, because a real page can put its whole body in
 * `class="menu"`.
 */
function isChrome(node, region, chrome = true) {
  if (node.type !== 'el') return false
  if (DROP.has(node.name)) return true
  if (!chrome) return false
  if (node === region) return false
  const roles = roleTokens(node)
  if (roles.includes('main')) return false
  if (node.name === 'pre' || node.name === 'code') return false
  if (roles.some((role) => ROLE_CHROME.has(role))) return true
  for (const key of ['id', 'class']) {
    const value = node.attrs?.[key]
    if (typeof value !== 'string') continue
    for (const token of value.split(/\s+/)) {
      if (token !== '' && CHROME_TOKEN.test(token)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

/** Resolve a link target against the page base; `undefined` means "drop it". */
function absoluteUrl(href, base) {
  if (typeof href !== 'string') return undefined
  const raw = href.trim()
  if (raw === '' || raw.startsWith('#')) return undefined
  if (/^(?:javascript|data|vbscript):/i.test(raw)) return undefined
  try {
    const url = new URL(raw, base)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return url.toString()
    }
    return undefined
  } catch {
    return undefined
  }
}

/** A backtick fence longer than any run inside the content. */
function fenceFor(text) {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Language hint from `class="language-js"` / `class="lang-js"`. */
function codeLanguage(node) {
  for (const candidate of [node, ...(node.children ?? []).filter((child) => child.type === 'el' && child.name === 'code')]) {
    const className = candidate.attrs?.class ?? ''
    const match = /(?:^|\s)(?:language|lang)-([A-Za-z0-9#+._-]+)/.exec(className)
    if (match !== null) return match[1]
    const dataLang = candidate.attrs?.['data-lang'] ?? candidate.attrs?.['data-language']
    if (typeof dataLang === 'string' && /^[A-Za-z0-9#+._-]+$/.test(dataLang)) return dataLang
  }
  return ''
}

function renderInlineChildren(node, ctx, depth = depthOf(node)) {
  let text = ''
  for (const child of node.children) text += renderInline(child, ctx, depth + 1)
  return text
}

/**
 * Text that will sit inside `[...]` or be an image's alt: one line, no
 * markdown link syntax (`](` would end the label and open a second link), no
 * `javascript:` token. A page cannot smuggle a link, a footer or a second line
 * into the answer through its own link or alt text.
 */
function inlineLabel(text) {
  return oneLine(text)
    .replace(/\]\s*\(/g, '] (')
    .replace(/javascript\s*:/gi, '')
    .trim()
}

function renderInline(node, ctx, depth = depthOf(node)) {
  if (node.type === 'text') return decodeEntities(node.value)
  if (node.type !== 'el') return ''
  if (depth >= MAX_DEPTH) return collapse(shallowText(node))
  if (isChrome(node, ctx.region, ctx.chrome !== false)) return ''
  if (node.name === 'br') return '\n'
  if (node.name === 'img') return node.attrs.alt ? inlineLabel(decodeEntities(node.attrs.alt)) : ''
  if (node.name === 'code') {
    const inner = collapse(rawText(node))
    if (inner === '') return ''
    const fence = fenceFor(inner)
    const pad = fence.length > 1 ? ' ' : ''
    return `${fence}${pad}${inner}${pad}${fence}`
  }
  if (node.name === 'a') {
    const text = inlineLabel(renderInlineChildren(node, ctx, depth))
    if (text === '') return ''
    const href = absoluteUrl(node.attrs.href, ctx.base)
    return href === undefined ? text : `[${text}](${href})`
  }
  return renderInlineChildren(node, ctx, depth)
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

/**
 * Chrome that sites put *inside* a `<pre>`: a copy button, a language label, a
 * line-number gutter. Its text is not code, so a `<pre>` skips it instead of
 * pasting "js copy" into the first line of the block.
 */
const PRE_CHROME = /(?:^|\s)(?:toolbar|code-toolbar|highlight-toolbar|copy|copy-button|line-numbers|linenodiv|filename)(?:\s|$)/i

function preText(node, depth = depthOf(node)) {
  if (node.type === 'text') return decodeEntities(node.value)
  if (node.type !== 'el') return ''
  if (depth >= MAX_DEPTH) return shallowText(node)
  let text = ''
  for (const child of node.children) {
    if (child.type === 'el') {
      if (DROP.has(child.name)) continue
      if (child.name === 'br') {
        text += '\n'
        continue
      }
      const className = typeof child.attrs?.class === 'string' ? child.attrs.class : ''
      if (PRE_CHROME.test(className) || child.attrs?.role === 'toolbar') continue
    }
    text += preText(child, depth + 1)
  }
  return text
}

function renderPre(node) {
  const raw = preText(node).replace(/^\r?\n/, '').replace(/\r\n/g, '\n')
  const text = raw.replace(/\n+$/, '')
  if (text === '') return ''
  const fence = fenceFor(text)
  const language = codeLanguage(node)
  return `${fence}${language}\n${text}\n${fence}`
}

function renderList(node, ctx, depth = 0) {
  const lines = []
  const indent = '  '.repeat(depth)
  for (const child of node.children) {
    if (child.type === 'text') continue
    if (child.type !== 'el') continue
    if (child.name !== 'li') {
      if (child.name === 'ul' || child.name === 'ol' || child.name === 'menu') {
        const nested = renderList(child, ctx, depth + 1)
        if (nested !== '') lines.push(nested)
      }
      continue
    }

    const inline = []
    const nested = []
    const blocks = []
    for (const part of child.children) {
      if (part.type === 'el' && (part.name === 'ul' || part.name === 'ol' || part.name === 'menu')) {
        const sub = renderList(part, ctx, depth + 1)
        if (sub !== '') nested.push(sub)
      } else if (part.type === 'el' && part.name === 'pre') {
        const block = renderPre(part)
        if (block !== '') blocks.push(block)
      } else {
        inline.push(part)
      }
    }

    const text = collapse(renderInlineChildren({ type: 'el', name: '#inline', children: inline }, ctx))
    if (text !== '') lines.push(`${indent}- ${text}`)
    // A nested list continues the item; a code block needs its own paragraph.
    lines.push(...nested)
    for (const block of blocks) lines.push('', block)
  }
  return lines.join('\n')
}

/**
 * `true` when a cell holds real block content (a paragraph, list, heading,
 * quote, nested table or code block). A table like that is page layout — the
 * GitHub issue layout, where the comment body lives in a `<td>` — and turning
 * it into pipe rows would flatten every paragraph and lose every code fence.
 */
function containsBlock(node, depth = depthOf(node)) {
  if (depth >= MAX_DEPTH) return false
  for (const child of node.children) {
    if (child.type !== 'el') continue
    if (child.name === 'p' || child.name === 'pre' || child.name === 'ul' || child.name === 'ol' ||
      child.name === 'blockquote' || child.name === 'table' || /^h[1-6]$/.test(child.name)) {
      return true
    }
    if (containsBlock(child, depth + 1)) return true
  }
  return false
}

function isLayoutTable(node, depth = depthOf(node)) {
  if (depth >= MAX_DEPTH) return false
  for (const child of node.children) {
    if (child.type !== 'el') continue
    if (child.name === 'tr') {
      for (const cell of child.children) {
        if (cell.type === 'el' && (cell.name === 'td' || cell.name === 'th') && containsBlock(cell)) return true
      }
    } else if (child.name !== 'table' && isLayoutTable(child, depth + 1)) {
      return true
    }
  }
  return false
}

function renderTable(node, ctx, depth = depthOf(node)) {
  const rows = []
  let header = false

  const walk = (element, at) => {
    if (at >= MAX_DEPTH) return
    for (const child of element.children) {
      if (child.type !== 'el') continue
      if (child.name === 'tr') {
        const cells = child.children
          .filter((cell) => cell.type === 'el' && (cell.name === 'td' || cell.name === 'th'))
        if (cells.length === 0) continue
        if (rows.length === 0 && cells.some((cell) => cell.name === 'th')) header = true
        const values = cells.map((cell) => collapse(renderInlineChildren(cell, ctx)))
        rows.push(`| ${values.join(' | ')} |`)
        if (header && rows.length === 1) {
          rows.push(`| ${values.map(() => '---').join(' | ')} |`)
        }
      } else if (child.name !== 'table') {
        walk(child, at + 1)
      }
    }
  }

  walk(node, depth)
  return rows.join('\n')
}

/** Prefix every line of a block with `> `. */
function quoteBlock(text) {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** Render a node's children into blocks, accumulating inline text as one block. */
function renderBlocks(node, ctx, out, depth = depthOf(node)) {
  let buffer = ''
  const flush = () => {
    const text = collapse(buffer)
    if (text !== '') out.push(text)
    buffer = ''
  }

  if (depth >= MAX_DEPTH) {
    // The depth budget is spent: keep the words, not the structure.
    const text = collapse(shallowText(node))
    if (text !== '') out.push(text)
    return
  }

  for (const child of node.children) {
    if (child.type === 'text') {
      buffer += decodeEntities(child.value)
      continue
    }
    if (child.type !== 'el') continue
    if (isChrome(child, ctx.region, ctx.chrome !== false)) continue

    const heading = /^h([1-6])$/.exec(child.name)
    if (heading !== null) {
      flush()
      const text = collapse(renderInlineChildren(child, ctx, depth + 1))
      if (text !== '') out.push(`${'#'.repeat(Number(heading[1]))} ${text}`)
      continue
    }

    switch (child.name) {
      case 'p':
        flush()
        {
          const text = collapse(renderInlineChildren(child, ctx, depth + 1))
          if (text !== '') out.push(text)
        }
        continue
      case 'pre':
        flush()
        {
          const block = renderPre(child)
          if (block !== '') out.push(block)
        }
        continue
      case 'ul':
      case 'ol':
      case 'menu':
        flush()
        {
          const list = renderList(child, ctx)
          if (list !== '') out.push(list)
        }
        continue
      case 'blockquote':
        flush()
        {
          const inner = []
          renderBlocks(child, ctx, inner, depth + 1)
          if (inner.length > 0) out.push(quoteBlock(inner.join('\n\n')))
        }
        continue
      case 'table':
        flush()
        if (isLayoutTable(child)) {
          // Layout, not data: keep the blocks inside its cells.
          renderBlocks(child, ctx, out, depth + 1)
        } else {
          const table = renderTable(child, ctx)
          if (table !== '') out.push(table)
        }
        continue
      case 'hr':
        flush()
        out.push('---')
        continue
      case 'br':
        buffer += ' '
        continue
      case 'a':
      case 'code':
      case 'strong':
      case 'b':
      case 'em':
      case 'i':
      case 'span':
      case 'small':
      case 'mark':
      case 'sub':
      case 'sup':
      case 'kbd':
      case 'samp':
      case 'var':
      case 'abbr':
      case 'cite':
      case 'q':
      case 'time':
      case 'label':
        buffer += renderInline(child, ctx, depth + 1)
        continue
      default:
        break
    }

    if (BLOCK.has(child.name) || containsBlock(child)) {
      // A container: its children decide the blocks. That includes a custom
      // element (`<turbo-frame>`, `<react-app>`) that merely wraps the page:
      // flattening it as inline text would destroy every paragraph and fence
      // inside it.
      const inner = []
      renderBlocks(child, ctx, inner, depth + 1)
      if (inner.length > 0) {
        flush()
        out.push(...inner)
      }
      continue
    }

    buffer += renderInline(child, ctx, depth + 1)
  }

  flush()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `<base href>` resolved against the response URL, else the response URL.
 *
 * Only a **same-origin** base is honoured. A page can otherwise point every
 * relative link at `http://169.254.169.254/latest/` and the answer would render
 * `[click](http://169.254.169.254/latest/meta-data/)` — a metadata endpoint the
 * model might then be tempted to fetch. Ignoring the cross-origin base leaves
 * the links relative to the page that was actually read.
 */
function pageBase(root, baseUrl) {
  const base = findElement(root, 'base')
  if (base !== undefined && typeof base.attrs.href === 'string') {
    try {
      const resolved = new URL(base.attrs.href.trim(), baseUrl)
      const page = new URL(baseUrl)
      const sameOrigin = resolved.origin === page.origin
      if (sameOrigin && (resolved.protocol === 'http:' || resolved.protocol === 'https:')) {
        return resolved.toString()
      }
    } catch {
      // A broken base href (or an unparseable page URL) is ignored; relative
      // links then use the response URL.
    }
  }
  return baseUrl
}

/**
 * The page title, safe to put on the answer's first line: one line, no control
 * characters, at most `TITLE_MAX` characters. A newline in `<title>` followed
 * by a parenthesised string used to render a second line that looked exactly
 * like the tool's own footer.
 */
function documentTitle(root) {
  const title = findElement(root, 'title')
  if (title !== undefined) {
    const text = clip(oneLine(rawText(title)), TITLE_MAX)
    if (text !== '') return text
  }
  const h1 = findElement(root, 'h1')
  if (h1 !== undefined) {
    const text = clip(oneLine(renderInlineChildren(h1, { base: undefined })), TITLE_MAX)
    if (text !== '') return text
  }
  return ''
}

/** Depth-first search for the first element matching `predicate`. */
function findWhere(node, predicate, depth = depthOf(node)) {
  if (depth > MAX_DEPTH) return undefined
  for (const child of node.children ?? []) {
    if (child.type !== 'el') continue
    if (predicate(child)) return child
    const found = findWhere(child, predicate, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** All text under a node with chrome subtrees left out; entities decoded. */
function visibleText(node, region, depth = depthOf(node), chrome = true) {
  if (node.type === 'text') return decodeEntities(node.value)
  if (node.type !== 'el') return ''
  if (depth >= MAX_DEPTH) return shallowText(node)
  let text = ''
  for (const child of node.children) {
    if (child.type === 'el') {
      if (isChrome(child, region, chrome)) continue
      if (child.name === 'br') {
        text += '\n'
        continue
      }
    }
    text += visibleText(child, region, depth + 1, chrome)
  }
  return text
}

/**
 * Content-region candidates, best first. Documentation sites often cannot use
 * `<main>` (a CMS or a 2005-era layout owns the markup) but still say which
 * element is the article: `role=main` on nodejs.org, `#apicontent` on the same
 * page, `.markdown-body` on GitHub, `.document` on Sphinx. Declared ids come
 * before generic classes because they are unambiguous.
 */
const REGION_CANDIDATES = [
  (element) => roleTokens(element).includes('main'),
  (element) => element.name === 'main',
  (element) => element.name === 'article',
  (element) => element.attrs.id === 'apicontent',
  (element) => element.attrs.id === 'main-content',
  (element) => classTokens(element).includes('markdown-body'),
  (element) => classTokens(element).includes('doc-content'),
  (element) => classTokens(element).includes('document'),
]

function classTokens(node) {
  const value = typeof node.attrs?.class === 'string' ? node.attrs.class : ''
  return value.split(/\s+/).filter((token) => token !== '')
}

/**
 * The best content region: the first candidate that exists *and* has text of
 * its own, then `<body>`, then the whole tree. An empty `<main>` (the shell of
 * a client-rendered app) falls through instead of yielding a blank page.
 */
function pickRegion(root) {
  for (const match of REGION_CANDIDATES) {
    const element = findWhere(root, match)
    if (element !== undefined && collapse(visibleText(element, element)) !== '') return element
  }
  const body = findElement(root, 'body')
  if (body !== undefined && collapse(visibleText(body, body)) !== '') return body
  return root
}

/**
 * Below this many characters an extracted region is suspicious: a real article
 * is longer, so the answer was probably eaten by the chrome heuristic rather
 * than by the page having no prose.
 */
const MIN_REGION_TEXT = 200

/** Render a region into the answer text. */
function renderRegion(region, ctx) {
  const blocks = []
  renderBlocks(region, ctx, blocks)
  return sanitise(blocks.filter((block) => block.trim() !== '').join('\n\n')).trim()
}

/**
 * Extract readable text from an HTML document.
 *
 * @param {string} html
 * @param {string} baseUrl absolute URL used to resolve relative links
 * @returns {{ title: string, text: string }}
 */
export function extractHtml(html, baseUrl) {
  if (typeof html !== 'string' || html === '') return { title: '', text: '' }
  const root = buildTree(html)
  const region = pickRegion(root)
  const base = pageBase(root, baseUrl)
  const title = documentTitle(root)

  let text = renderRegion(region, { base, region, chrome: true })

  // `class="menu"` (or `-nav`) matches the chrome filter, and a page may put its
  // whole body in such a container. Before reporting "no text", measure the
  // region with the heuristic off: if there was substantial prose there, render
  // it without the filter.
  if (charCount(text) < MIN_REGION_TEXT) {
    const unfiltered = collapse(visibleText(region, region, undefined, false))
    // An empty answer is always wrong when anything visible remains, however
    // short; otherwise a substantial hidden body is what justifies dropping the
    // heuristic (a short page can legitimately be a heading and one sentence).
    const worthRetrying =
      charCount(unfiltered) >= MIN_REGION_TEXT ||
      (charCount(text) === 0 && charCount(unfiltered) > 0)
    if (worthRetrying) {
      const loose = { base, region, chrome: false }
      text = renderRegion(region, loose)
      if (charCount(text) < MIN_REGION_TEXT) {
        const body = findElement(root, 'body')
        if (body !== undefined && body !== region) {
          const bodyText = renderRegion(body, { base, region: body, chrome: false })
          if (charCount(bodyText) > charCount(text)) text = bodyText
        }
      }
    }
  }

  return { title, text }
}

/** Number of characters (code points, not UTF-16 units) in `text`. */
export function charCount(text) {
  if (typeof text !== 'string') return 0
  let count = 0
  for (const _ of text) count += 1
  return count
}

/**
 * The UTF-16 index of the `points`-th code point. Used so a `maxChars` cut can
 * never land between the two halves of an emoji.
 */
function unitIndex(text, points) {
  let seen = 0
  let index = 0
  while (index < text.length && seen < points) {
    const code = text.charCodeAt(index)
    const high = code >= 0xd800 && code <= 0xdbff
    index += high && index + 1 < text.length ? 2 : 1
    seen += 1
  }
  return index
}

/**
 * Slice `text` by code points: `[start, start + count)` with a 0-based start.
 * The result is exactly what a per-character reader would see, so successive
 * slices concatenate back into the original string.
 */
export function slicePoints(text, start, count) {
  if (typeof text !== 'string' || text === '') return ''
  const from = unitIndex(text, Math.max(0, start))
  const to = count === undefined ? text.length : unitIndex(text, Math.max(0, start) + Math.max(0, count))
  return text.slice(from, to)
}
