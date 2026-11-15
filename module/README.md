# com.z1.web

The agent's own web tools for z1 workers. Version `0.2.0`, module id
`com.z1.web`, MIT.

Four tools, one worker-mode `tools` service, no accounts and no API keys:

- `web.search` — searches the web through the native SearXNG instance that the
  z1 CLI provisions and starts on the loopback interface. This module never
  installs or starts it.
- `stack.search` — searches Stack Exchange's public API (Stack Overflow by
  default), anonymously.
- `github.issues` — searches GitHub issues and pull requests through the REST
  search API, anonymously or with `Z1_GITHUB_TOKEN`.
- `web.status` — reports the backend's state in two lines and says that the two
  public-API tools work without it.

Every request leaves the worker through `ctx.net.request`, so the host's
allowlist, SSRF classifier, redirect re-checks and 1 MiB cap still apply. The
only backend is SearXNG on `127.0.0.1:8888`, configured by
`assets/searxng.settings.yml` in this repository.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `web.search` | `query` (required, ≤500 chars); `count` 1–20 (default 8); `site` (hostname suffix such as `docs.python.org`, also sent as `site:` and re-checked by host); `language` (BCP-47 or `all`); `recency` (`day`/`week`/`month`/`year`); `safe` (boolean) | Numbered results `N. title — url`, an indented snippet of at most 300 chars, and a `(searxng · shown of total · ms)` footer. |
| `stack.search` | `query` (required, ≤500 chars); `site` (slug, default `stackoverflow`); `tags` (string or array, at most 5, comma-separated strings accepted); `accepted` (boolean); `sort` (`relevance`/`votes`/`creation`/`activity`); `limit` 1–30 (default 8) | Numbered questions with `score · N answers · accepted · tags: … · date`, and a `(site · shown of total · quota left/max)` footer. |
| `github.issues` | `query` (required, ≤500 chars); `repo` (`owner/name`, sent as `repo:`); `state` (`open`/`closed`/`all`, default open); `kind` (`issue`/`pr`/`any`, default issue); `sort` (`relevance`/`created`/`updated`/`comments`); `limit` 1–20 (default 8) | Numbered hits with `owner/repo · state · N comments · updated YYYY-MM-DD · #number`, and a `(github · shown of total · N/M requests left this minute)` footer. |
| `web.status` | none | Two lines: SearXNG URL and `healthy`, `starting` (z1 is installing/launching it) or `down` with a short reason; then that the two keyless tools are available anyway. Pings `/healthz` with a 3 s cap and never throws. |

Arguments are validated locally before any request: a typo costs no quota. A
bad Stack Exchange slug is rejected with the name that was tried; a GitHub
`repo:` that is not `owner/name`, a `q` built past 256 characters, an
out-of-range `limit` and more than five tags are all refused before the call.

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

## Quotas and caching

| Tool | Upstream | Anonymous quota | Cache |
| --- | --- | --- | --- |
| `stack.search` | `api.stackexchange.com/2.3/search/advanced` | 300 requests/day per IP | 10 min, 50 entries |
| `github.issues` | `api.github.com/search/issues` | 10 requests/minute per IP; 30 with `Z1_GITHUB_TOKEN` | 5 min, 50 entries |
| `web.search` | local SearXNG | none (your own instance) | 10 min, 50 entries |
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
z1 module approve com.z1.web@0.2.0
```

`propose` copies the whole `module/` directory (`manifest.json`, `index.js`,
`lib/`, `assets/`, `README.md`, `LICENSE`) plus a generated `package.json`, and
`approve` shows the grant below before it is accepted. Then enable a tool in a
session:

```text
/tools on stack.search
```

All four tools belong to the same service; `web.status` takes no arguments and
is the cheapest first check. Verify with `z1 module list`.

## Backend: SearXNG

The CLI provisions a native SearXNG (~120 MB on first run) and starts it on
`127.0.0.1:8888` at launch. This module does not start, install or restart it,
and there is no long-lived server in this repository. `web.status` reports:

```text
searxng · http://127.0.0.1:8888 · healthy · 4 ms
stack.search · github.issues · keyless · available (Stack Exchange 300/day per IP · GitHub 10/min anonymous)
```

- `healthy` — the probe got HTTP 200, whatever the environment says.
- `starting` — the probe failed and the host exported `Z1_SEARX_STATE` as
  `installing`/`starting` (optionally `starting:<epochMs>`; a hint older than 2
  minutes is ignored, so a crash cannot leave the word stuck — the install takes
  ~35 s and a worker's environment snapshot never updates).
- `down` — neither; the line says who starts it.

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
{ "net": { "hosts": ["*", "127.0.0.1", "[::1]"] } }
```

- `*` means **public internet only**: a wildcard is not an SSRF grant. The host
  refuses loopback, LAN, link-local and cloud-metadata targets unless the
  manifest names that exact host.
- `127.0.0.1` and `[::1]` are those explicit literals, which is why the local
  SearXNG is reachable at all.
- `localhost` is not granted by name; with `Z1_SEARX_URL=http://localhost:8888`
  the request is denied until you add `"localhost"`. The default URL
  deliberately uses `127.0.0.1`.

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
- **No page bodies.** `web.search` returns snippets only; `stack.search` sends
  `filter=default` so no answer bodies are shipped; `github.issues` returns
  titles and metadata, not bodies. There is no fetch tool in this module.
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

```bash
node test/test-fixture.mjs   # fake ctx.net, fixtures only
```

It covers `web.search` normalisation, clipping, de-duplication, site filtering,
cache and error text, plus the four-schema/status contract.

## Licence

MIT, Copyright (c) 2026 ayzitix. See `LICENSE`.
