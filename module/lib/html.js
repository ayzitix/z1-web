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
 * Region selection is deliberate: `<main>` first, then `<article>`, then
 * `<body>`. Navigation, headers, footers, asides, forms and scripts are dropped
 * wherever they appear, so a docs page yields its prose and not its chrome.
 *
 * @module z1-web/html
 */

import { sanitise } from './format.js'

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
  const root = { type: 'el', name: '#root', attrs: {}, children: [] }
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

    const element = { type: 'el', name: tag.name, attrs: tag.attrs, children: [] }
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

/** Depth-first search for the first element with `name`. */
function findElement(node, name) {
  for (const child of node.children ?? []) {
    if (child.type !== 'el') continue
    if (child.name === name) return child
    const found = findElement(child, name)
    if (found !== undefined) return found
  }
  return undefined
}

/** All text under a node, whitespace preserved, entities decoded. */
function rawText(node) {
  if (node.type === 'text') return decodeEntities(node.value)
  if (node.type !== 'el') return ''
  let text = ''
  for (const child of node.children) {
    if (child.type === 'el') {
      if (DROP.has(child.name)) continue
      if (child.name === 'br') {
        text += '\n'
        continue
      }
    }
    text += rawText(child)
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
 */
function isChrome(node, region) {
  if (node.type !== 'el') return false
  if (node === region) return false
  const roles = roleTokens(node)
  if (roles.includes('main')) return false
  if (node.name === 'pre' || node.name === 'code') return false
  if (DROP.has(node.name)) return true
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

function renderInlineChildren(node, ctx) {
  let text = ''
  for (const child of node.children) text += renderInline(child, ctx)
  return text
}

function renderInline(node, ctx) {
  if (node.type === 'text') return decodeEntities(node.value)
  if (node.type !== 'el') return ''
  if (isChrome(node, ctx.region)) return ''
  if (node.name === 'br') return '\n'
  if (node.name === 'img') return node.attrs.alt ? decodeEntities(node.attrs.alt) : ''
  if (node.name === 'code') {
    const inner = collapse(rawText(node))
    if (inner === '') return ''
    const fence = fenceFor(inner)
    const pad = fence.length > 1 ? ' ' : ''
    return `${fence}${pad}${inner}${pad}${fence}`
  }
  if (node.name === 'a') {
    const text = collapse(renderInlineChildren(node, ctx))
    if (text === '') return ''
    const href = absoluteUrl(node.attrs.href, ctx.base)
    return href === undefined ? text : `[${text}](${href})`
  }
  return renderInlineChildren(node, ctx)
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

function preText(node) {
  if (node.type === 'text') return decodeEntities(node.value)
  if (node.type !== 'el') return ''
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
    text += preText(child)
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
function containsBlock(node) {
  for (const child of node.children) {
    if (child.type !== 'el') continue
    if (child.name === 'p' || child.name === 'pre' || child.name === 'ul' || child.name === 'ol' ||
      child.name === 'blockquote' || child.name === 'table' || /^h[1-6]$/.test(child.name)) {
      return true
    }
    if (containsBlock(child)) return true
  }
  return false
}

function isLayoutTable(node) {
  for (const child of node.children) {
    if (child.type !== 'el') continue
    if (child.name === 'tr') {
      for (const cell of child.children) {
        if (cell.type === 'el' && (cell.name === 'td' || cell.name === 'th') && containsBlock(cell)) return true
      }
    } else if (child.name !== 'table' && isLayoutTable(child)) {
      return true
    }
  }
  return false
}

function renderTable(node, ctx) {
  const rows = []
  let header = false

  const walk = (element) => {
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
        walk(child)
      }
    }
  }

  walk(node)
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
function renderBlocks(node, ctx, out) {
  let buffer = ''
  const flush = () => {
    const text = collapse(buffer)
    if (text !== '') out.push(text)
    buffer = ''
  }

  for (const child of node.children) {
    if (child.type === 'text') {
      buffer += decodeEntities(child.value)
      continue
    }
    if (child.type !== 'el') continue
    if (isChrome(child, ctx.region)) continue

    const heading = /^h([1-6])$/.exec(child.name)
    if (heading !== null) {
      flush()
      const text = collapse(renderInlineChildren(child, ctx))
      if (text !== '') out.push(`${'#'.repeat(Number(heading[1]))} ${text}`)
      continue
    }

    switch (child.name) {
      case 'p':
        flush()
        {
          const text = collapse(renderInlineChildren(child, ctx))
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
          renderBlocks(child, ctx, inner)
          if (inner.length > 0) out.push(quoteBlock(inner.join('\n\n')))
        }
        continue
      case 'table':
        flush()
        if (isLayoutTable(child)) {
          // Layout, not data: keep the blocks inside its cells.
          renderBlocks(child, ctx, out)
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
        buffer += renderInline(child, ctx)
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
      renderBlocks(child, ctx, inner)
      if (inner.length > 0) {
        flush()
        out.push(...inner)
      }
      continue
    }

    buffer += renderInline(child, ctx)
  }

  flush()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** `<base href>` resolved against the response URL, else the response URL. */
function pageBase(root, baseUrl) {
  const base = findElement(root, 'base')
  if (base !== undefined && typeof base.attrs.href === 'string') {
    try {
      const resolved = new URL(base.attrs.href.trim(), baseUrl)
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.toString()
    } catch {
      // A broken base href is ignored; relative links then use the page URL.
    }
  }
  return baseUrl
}

function documentTitle(root) {
  const title = findElement(root, 'title')
  if (title !== undefined) {
    const text = collapse(rawText(title))
    if (text !== '') return text
  }
  const h1 = findElement(root, 'h1')
  if (h1 !== undefined) {
    const text = collapse(renderInlineChildren(h1, { base: undefined }))
    if (text !== '') return text
  }
  return ''
}

/** Depth-first search for the first element matching `predicate`. */
function findWhere(node, predicate) {
  for (const child of node.children ?? []) {
    if (child.type !== 'el') continue
    if (predicate(child)) return child
    const found = findWhere(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/** All text under a node with chrome subtrees left out; entities decoded. */
function visibleText(node, region) {
  if (node.type === 'text') return decodeEntities(node.value)
  if (node.type !== 'el') return ''
  let text = ''
  for (const child of node.children) {
    if (child.type === 'el') {
      if (isChrome(child, region)) continue
      if (child.name === 'br') {
        text += '\n'
        continue
      }
    }
    text += visibleText(child, region)
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
  const ctx = { base: pageBase(root, baseUrl), region }
  const title = documentTitle(root)
  const blocks = []
  renderBlocks(region, ctx, blocks)
  const text = sanitise(blocks.filter((block) => block.trim() !== '').join('\n\n')).trim()
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
