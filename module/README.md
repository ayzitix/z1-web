# com.z1.web

The agent's own web tools for z1 workers. Version `0.3.3`, module id
`com.z1.web`, MIT.

Five tools, one worker-mode `tools` service, no accounts and no API keys:

- `web.search` — searches the web through the native SearXNG instance that the
  z1 CLI provisions and starts on the loopback interface. This module never
  installs or starts it.
- `web.fetch` — reads one public URL and returns its readable text: headings,
  paragraphs, lists, tables and fenced code, or the body of a plain-text or JSON
  response. PDFs and binary bodies are refused, not returned.
- `stack.search` — searches Stack Exchange's public API (Stack Overflow by
  default), anonymously.
- `github.issues` — searches GitHub issues and pull requests through the REST
  search API, anonymously or with `Z1_GITHUB_TOKEN`.
- `web.status` — reports the backend's state in two lines and says that the
  fetch and public-API tools work without it.

Every request leaves the worker through `ctx.net.request`, so the host's
allowlist, SSRF classifier, redirect re-checks and 1 MiB cap still apply. The
only backend is SearXNG on `127.0.0.1:8888`, configured by
`assets/searxng.settings.yml` in this repository.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `web.search` | `query` (required, ≤500 chars); `count` 1–20 (default 8); `site` (hostname suffix such as `docs.python.org`, also sent as `site:` and re-checked by host); `language` (BCP-47 or `all`); `recency` (`day`/`week`/`month`/`year`); `safe` (boolean) | Numbered results `N. title — url`, an indented snippet of at most 300 chars, and a `(searxng · shown of total results · ms)` footer — plus `2 pages` when a second SearXNG page was fetched and `max 10 per page` when a short list is the backend's page size, not the end of the results. |
| `web.fetch` | `url` (required, absolute http(s)); `offset` (1-based character offset, ≥1, default 1); `maxChars` 1000–100000 (default 50000) | A `title: TITLE — url` line when the page has a title, a `(content-type · N chars · showing a–b · ms · cached: no)` footer, then the extracted body as blocks; truncated answers end with `offset=N` to continue. |
| `stack.search` | `query` (required, ≤500 chars); `site` (slug, default `stackoverflow`); `tags` (string or array, at most 5, comma-separated strings accepted); `accepted` (boolean); `sort` (`relevance`/`votes`/`creation`/`activity`); `limit` 1–30 (default 8) | Numbered questions with `score · N answers · accepted · tags: … · date`, and a `(site · shown of total · quota left/max)` footer. |
| `github.issues` | `query` (required, ≤500 chars); `repo` (`owner/name`, sent as `repo:`); `state` (`open`/`closed`/`all`, default open); `kind` (`issue`/`pr`/`any`, default issue); `sort` (`relevance`/`created`/`updated`/`comments`); `limit` 1–20 (default 8) | Numbered hits with `owner/repo · state · N comments · updated YYYY-MM-DD · #number`, and a `(github · shown of total · N/M requests left this minute)` footer. |
| `web.status` | none | Two lines: SearXNG URL and `healthy`, `starting` (z1 is installing/launching it), `unhealthy` (something answered but is not SearXNG) or `down`, each with a short reason (`HTTP 500`, `no answer within 3000 ms`, `connection refused`); then that the two keyless tools are available anyway. Pings `/healthz` (and `/config` when the fingerprint is missing) with a 3 s cap and never throws. |

Arguments are validated locally before any request: a typo costs no quota. A
bad Stack Exchange slug is rejected with the name that was tried; a GitHub
`repo:` that is not `owner/name`, a `q` built past 256 characters, an
out-of-range `limit` and more than five tags are all refused before the call.

### Result count, paging and the footer

SearXNG serves **ten results a page** whatever `count` is. `web.search` returns
`count` hits (1–20, default 8): up to ten from one request, and when `count` is
above ten and page one came back full it requests page two as well, so a
`count: 15` costs two requests and the footer says so:

```text
(searxng · 15 of 246 results · 2 pages · 310 ms)
```

If page two is not requested — page one was short, so there was nothing behind
it — the footer says `max 10 per page` instead of implying the list is complete:

```text
(searxng · 7 of 7 results · 118 ms · max 10 per page)
```

`shown of total` counts what SearXNG returned before de-duplication and `site`
filtering, so it always tells the model whether it is seeing a slice. Pages
overlap when engines disagree about order; a URL already seen on page one is
dropped, never rendered twice.

### Examples

`stack.search` with `{"query":"rust error E0502","limit":3,"accepted":true,"tags":["rust"]}`,
live:

```text
1. Rust `Vec` - cannot borrow `Vec` as immutable inside `impl` method (error[E0502]) — https://stackoverflow.com/questions/62812527/…
   score 2 · 1 answer · accepted · tags: vector, rust, borrowing · 2020-07-09
2. Why is Rust NLL not working for multiple borrows in the same statement? — https://stackoverflow.com/questions/71823410/…
   score 34 · 2 answers · accepted · tags: rust, borrow-checker · 2022-04-11
(stackoverflow · 3 of 3 · quota 287/300)
```

`github.issues` with `{"query":"rust error E0502","repo":"rust-lang/rust","kind":"pr","limit":3}`:

```text
1. borrowck: clarify an E0502 label for &self.field vs mutable self — https://github.com/rust-lang/rust/pull/155116
   rust-lang/rust · open · 5 comments · updated 2026-07-24 · #155116
(github · 3 of 6 · 0/10 requests left this minute)
```

Empty searches are one explanatory line that names the query that was actually
sent (including the qualifiers the tool added):

```text
(no issues for "zzz state:open is:issue"; drop repo: · try state: all · shorten the keywords · 9/10 requests left this minute)
```

### GitHub qualifier policy

`github.issues` owns three qualifiers because it builds them from arguments:
`repo:` comes from `repo`, `state:` from `state`, and `is:issue`/`is:pr` from
`kind`. A copy typed into `query` is **stripped** — sent twice it would be
appended after the tool's own and could widen or contradict the search — so
`"repo:evil/repo state:closed is:pr crash"` with `repo: rust-lang/rust` and
`state: open` becomes `repo:rust-lang/rust crash state:open is:issue`. A `query`
that is nothing but those qualifiers is refused (`query must contain keywords,
not only repo:/state:/is: qualifiers`) rather than sent empty.

Every other qualifier the model writes is passed through verbatim, because the
tool cannot know it better: `label:`, `user:`, `org:`, `author:` and
`milestone:` reach GitHub untouched, so `{"query":"label:bug crash"}` searches
that label plus the keyword, and the footer and `q` show exactly what was sent.

## web.fetch — reading a page

`web.fetch` takes one URL and returns text a model can read, never markup. It
parses the document, picks `[role=main]`, `<main>`, `<article>` or `<body>` (in
that order), drops `nav`, `header`, `footer`, `aside`, `form`, `script`, `style`,
`svg` and hidden content, and joins what is left as blocks separated by one
blank line. If a region ends up (nearly) empty because the page's whole body sits
in a chrome-looking container such as `class="menu"`, the region is rendered
again with the chrome filter off instead of answering "(the page returned no
text)". Parsing is depth-bounded at **512 levels**: a document 60 000 `<div>`s
deep degrades to text at the limit instead of raising `RangeError`.

| Type (from `content-type`) | What comes back |
| --- | --- |
| HTML / XHTML | Extracted blocks: `#`/`##` headings, paragraphs, `- ` lists, `> ` quotes, `\| a \| b \|` tables with a `\| --- \|` header separator, fenced code with its language, indentation and blank lines, inline `<code>` as a single-backtick span (`` `code` ``), and links as `[text](url)` resolved against `<base href>` or the final URL. Only a **same-origin** `<base href>` is honoured: a page that points it at `169.254.169.254` or another host keeps every link on the URL that was actually fetched, and drops the base. A regular grid of cells whose content is paragraphs is **data** and renders as pipe rows; a table is **layout** only when a cell holds a heading, code block, list, quote, nested table, `colspan`/`rowspan`, when its rows disagree about their width, or when every row is a single cell — then its blocks are kept and no pipes are emitted. A custom element (`<turbo-frame>`, `<react-app>`) is a container: its paragraphs and fences survive. |
| `text/plain`, `text/markdown`, XML, JS | The body verbatim, minus a leading UTF-8 BOM. No extraction and no reflow, so ASCII tables and RFC indentation are intact. |
| JSON | Pretty-printed with two spaces, so a one-line API answer is readable. |
| PDF | Refused, with the size: `web.fetch: PDF is not supported yet (1 234 567 bytes) · fetch the HTML version or a text mirror`. |
| Anything else | Refused with the type named: `web.fetch: image/png is not text (48 213 bytes) — https://…`. |

A body with no `content-type` is sniffed — HTML when it starts with `<`, JSON
when it parses, text otherwise — and the footer says `(sniffed)`. A declared type
that the body contradicts is sniffed too, because static hosts and mirrors
mislable HTML as `text/plain` and some APIs answer JSON under `text/html`: the
footer then reads `text/plain (sniffed html)` or `text/html (sniffed json)`, and
the body is extracted as that type instead of dumped as source.

**Output shape.** Line 1 is `title: TITLE — url`, omitted when the page has
neither a `<title>` nor a first `<h1>`; line 2 is the footer; a blank line; then
the body:

```text
title: Stream | Node.js v26.13.1 Documentation — https://nodejs.org/api/stream.html
(text/html · 212 317 chars · showing 1–50000 · 210 ms · cached: no)

# Stream
…
```js
const stream = require('node:stream');
```
```

The `title: ` prefix is deliberate: the footer is a bare parenthetical, so a
page title of `Evil\n(text/html · 99 999 chars · …)` would otherwise render a
second line indistinguishable from a real footer. The title is flattened to one
line, clipped at 160 characters, and any trailing parenthetical carrying a
footer's tell-tales (a `·`, `N chars` or `cached:`) is stripped; the prefix
covers whatever survives. Ordinary prose parentheses stay (`Writing (2024)`).
An inline `<svg><title>` is never the page title — the `<title>` element or a
visible `<h1>` is.

A page also controls its `href`s, so `(` and `)` — and `[`, `]`, `<`, `>`, `\`,
`` ` ``, `|` — are percent-encoded in a link destination. A URL such as
`https://good.example/a)[](https://evil.example/pwn)` therefore renders as one
link with an encoded destination, never as `[click](…)(…)` and a second link
the model might read as the page's own. Brackets and parentheses inside link
text are backslash-escaped for the same reason, and a `javascript:` href is
dropped, leaving only its text.

The footer counts the whole document in code points (`212 317 chars`), not the
slice, so it says how much is left; `body capped at 1 MiB` appears when the
host's body cap cut the download.

**Paging.** `maxChars` is 50 000 by default and 100 000 at the most; `offset`
is 1-based and counts code points, so a cut never lands inside an emoji or a
surrogate pair. A cut answer ends with
`… (truncated at 50000 chars; call web.fetch with offset=50001)`, and the next
call continues at exactly that character: fetching `maxChars:1000`, then
`offset:1001`, reproduces `full[0:2000]` exactly (verified live against
`nodejs.org/api/stream.html`). An `offset` past the end is one notice naming the
real length and `offset=1`, never an error.

**Cache.** One entry per **URL**, held for 10 minutes, and the whole cache is
capped at **8 MiB** of stored text (UTF-16, so roughly four ~1 MiB pages), not at
a fixed number of answers; the least recently used entry is evicted when the cap
is reached. `offset` and `maxChars` are not part of the key — they slice the one
stored page — so paging a long document costs one request in total and a repeat
of any slice costs none. Only successful answers are cached; a hit prints
`cached: yes` in the footer.

**Untrusted.** A page body is attacker-controlled text from the open internet:
control characters, bidi overrides and zero-width marks are stripped, HTML is
reduced to inert blocks, and the tool description tells the model not to follow
instructions found in a page. Nothing here opens a link, runs code or trusts a
`javascript:` href.

**Private hosts are refused by the host, not here.** `web.fetch` sends the URL
through `ctx.net.request`, so the manifest's grant decides: `*` means public
internet only, and the port-scoped `127.0.0.1:8888`/`[::1]:8888` entries exist
for SearXNG alone — a different loopback port is still denied. Loopback, LAN,
link-local, cloud-metadata targets and URLs carrying credentials are denied
before a connection is made, and every redirect hop is re-checked.

## Quotas and caching

| Tool | Upstream | Anonymous quota | Cache |
| --- | --- | --- | --- |
| `stack.search` | `api.stackexchange.com/2.3/search/advanced` | 300 requests/day per IP | 10 min, up to 50 answers |
| `github.issues` | `api.github.com/search/issues` | 10 requests/minute per IP; 30 with `Z1_GITHUB_TOKEN` | 5 min, up to 50 answers |
| `web.search` | local SearXNG | none (your own instance) | 10 min, up to 50 answers |
| `web.fetch` | any public URL | no quota of its own | 10 min, one entry per URL, 8 MiB total |
| `web.status` | `/healthz` | none | never cached |

Only successful answers are cached — an empty list counts as an answer, an
error never does — so a fixed argument really does hit the network, and a
backend that just started is not hidden behind a cached failure. Each tool has
its own cache; a `stack.search` answer can never be served to `github.issues`.
Cache keys cover the normalised parameters (site, query, tags, accepted, sort,
limit; the built GitHub `q`) and the SearXNG base URL — never a credential, so
changing `Z1_GITHUB_TOKEN` does not create a second entry and the token appears in
no key, output or error. The caches live in the worker process and die with it;
a hit appends ` · cached` and repeats the original quota/rate line.

Stack Exchange reports its remaining quota in every response (that number is
what the footer prints; it does not decrement locally). When it reaches zero the
tool refuses locally until 00:00 UTC instead of spending a call to be told 429;
a `backoff` or `Retry-After` is honoured the same way, with the remaining time
in the error. GitHub's footer comes from `x-ratelimit-remaining/_limit` for the
`search` resource, i.e. the budget left *after* the request that produced the
answer, so `0/10` means the next call will be refused until the reset minute.

## Install

From a checkout of this repository — the module is the `module/` subdirectory,
never the repository root:

```bash
z1 module propose ~/Projects/z1-web/module
z1 module approve com.z1.web@0.3.3
```

`propose` copies the whole `module/` directory (`manifest.json`, `index.js`,
`lib/`, `assets/`, `README.md`, `LICENSE`) plus a generated `package.json`, and
`approve` shows the grant below before it is accepted. Then enable a tool in a
session:

```text
/tools on stack.search
```

All five tools belong to the same service; `web.status` takes no arguments and
is the cheapest first check. Verify with `z1 module list`.

## Backend: SearXNG

The CLI provisions a native SearXNG (~120 MB on first run) and starts it on
`127.0.0.1:8888` at launch. This module does not start, install or restart it,
and there is no long-lived server in this repository. `web.status` reports:

```text
searxng · http://127.0.0.1:8888 · healthy · 4 ms
stack.search · github.issues · keyless · available (Stack Exchange 300/day per IP · GitHub 10/min anonymous)
```

- `healthy` — the probe got HTTP 200 **and** a SearXNG fingerprint: the literal
  `OK` from `/healthz`, or a `/config` JSON body that names searxng. A bare 200
  proves nothing — a proxy, a dev server or a stale error page on port 8888
  answers 200 too — so a 200 that fails `/healthz` is re-checked against
  `/config` before the state is decided. A live answer beats the hint.
- `starting` — the probe failed and the host exported `Z1_SEARX_STATE` as
  `installing`/`starting` (optionally `starting:<epochMs>`; a hint older than 2
  minutes is ignored, so a crash cannot leave the word stuck — the install takes
  ~35 s and a worker's environment snapshot never updates).
- `unhealthy` — something answered on that port but is not SearXNG: a 200 whose
  body failed both fingerprints (`HTTP 200 but the body is not SearXNG (no OK
  from /healthz, no searxng in /config)`), or a non-2xx status such as
  `HTTP 500`. The reason is on the line; the second line still says the keyless
  tools work.
- `down` — nothing usable answered and the host is not provisioning:
  `connection refused`, `no answer within 3000 ms` or `refused by the host
  allowlist`; the line says who starts the backend.

`unhealthy` is the case a status code alone cannot catch: a different service
that happens to own port 8888 must not be reported as a working backend.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z1_SEARX_URL` | `http://127.0.0.1:8888` | SearXNG base URL. Credentials are stripped before it is echoed anywhere. Read on every call, so an edit takes effect when the host restarts the worker. |
| `Z1_WEB_TIMEOUT_MS` | `15000` | Per-request deadline in ms, clamped to 250–30000 (the host aborts at 30 s). `web.status` caps its probe at 3 s. |
| `Z1_GITHUB_TOKEN` | unset | Preferred token name: the host passes this one into the worker environment. Sent as `Authorization: Bearer …`; raises the GitHub search quota to 30/min. Never echoed, logged, cached or included in an error. |
| `GITHUB_TOKEN` | unset | Fallback for local/native runs, read only when `Z1_GITHUB_TOKEN` is empty. Same handling and same 30/min quota. |
| `Z1_SEARX_STATE` (or `Z1_SEARX_STATUS`) | unset | Written by the host while it provisions the backend: `installing`, `starting`, `up`, `down`. Used only to say `starting` when the probe fails. |

## Grant to expect

```json
{ "net": { "hosts": ["*", "127.0.0.1:8888", "[::1]:8888"] } }
```

- `*` means **public internet only**: a wildcard is not an SSRF grant. The host
  refuses loopback, LAN, link-local and cloud-metadata targets unless the
  manifest names that exact host.
- `127.0.0.1:8888` and `[::1]:8888` are **port-scoped** grants: host *and* port
  must match. A host-only `127.0.0.1` entry would grant every loopback port — a
  page could then send `web.fetch` to an unrelated local service such as
  `http://127.0.0.1:35545/admin` — so the grant names the single port SearXNG
  listens on. The literal `host:port` is SearXNG only; every other loopback
  port stays denied.
- This requires an SDK whose capability matcher understands `host:port`:
  `checkNet` (pattern parse and per-request port check) and `checkNetTarget`
  (the same check after DNS resolution, so a private address cannot slip past
  on a different port). On an older SDK the port-bearing entry does not match
  and SearXNG is unreachable — a visible failure, not a wider grant.
- `localhost` is not granted by name; with `Z1_SEARX_URL=http://localhost:8888`
  the request is denied until you add `"localhost:8888"` (not `"localhost"`,
  which would grant every localhost port). The default URL deliberately uses
  `127.0.0.1`.

There is no filesystem, process or LLM capability in the manifest.

## Limits (read these)

- **Results are untrusted text.** Titles, snippets and tags are
  attacker-controlled upstream data. They are stripped of control characters,
  bidi overrides and zero-width marks, flattened to one line and rendered
  inert; the tool descriptions tell the model not to follow instructions found
  in them. Nothing here opens a link or executes anything.
- **Snippets are clipped at 300 characters** (titles at 160) on code-point
  boundaries with `…` marking the cut. A snippet is a search teaser, not the
  page.
- **Page bodies come only from `web.fetch`.** `web.search` returns snippets
  only; `stack.search` sends `filter=default` so no answer bodies are shipped;
  `github.issues` returns titles and metadata, not bodies.
- **No re-ranking.** SearXNG's order is preserved; `shown of total` says whether
  the answer is a slice.
- **Stack Exchange counts every call, including a 400.** That is why argument
  validation and the local quota/backoff refusals exist. One IP shares one
  300/day budget across every anonymous client behind it, so a large NAT can run
  out without this worker sending anything.
- **GitHub anonymous search is 10/minute**, which is easy to exhaust by
  retrying; answers are cached for 5 minutes and the footer shows what is left.
  Setting `Z1_GITHUB_TOKEN` (or `GITHUB_TOKEN` locally) triples it to
  30/minute.
- **SearXNG engines rot.** Upstream sites block or change markup, so individual
  engines silently stop answering: that shows up as fewer results or an
  `unresponsive_engines` list, not as a module bug.
- **No disk cache, no telemetry.** The module logs nothing and keeps no state
  outside the three in-memory caches.

## Tests

The offline harness at the repository root needs no backend and no network:
every file installs a fake `ctx.net` and answers from fixtures under
`test/fixtures/`.

```bash
node test/test-fixture.mjs     # 79 checks — five-tool contract, web.search, status
node test/fetch-fixture.mjs    # 27 checks — web.fetch paging, cache, refusal, fingerprints
node test/html-fixture.mjs     # 42 checks — extraction: titles, tables, links, depth
node test/stack-fixture.mjs    # 28 checks — stack.search, quota and backoff clocks
node test/github-fixture.mjs   # 38 checks — github.issues, qualifiers, rate limit
```

**214 checks, all passing.** Together they cover the five-tool schema and status
contract; `web.search` normalisation, clipping, de-duplication, `site`
filtering, cache and error text; `web.fetch` loopback-port refusal, URL-keyed
paging and the 8 MiB byte cap, plus `healthy`/`unhealthy`/`down` fingerprint
rules; HTML extraction of forged titles and footers, data-vs-layout tables,
`<base>` and link escaping, and the 512-level depth bound; Stack Exchange
`accepted` normalisation, 429/`Retry-After` and the 00:00 UTC quota reset; and
the GitHub qualifier policy, token never reaching output or a cache key, and
401/403 text.

## Licence

MIT, Copyright (c) 2026 ayzitix. See `LICENSE`.
