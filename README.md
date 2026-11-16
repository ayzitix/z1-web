# z1-web

Web search for the z1 agent: a native, loopback-only SearXNG instance plus the
`com.z1.web` module that exposes `web.search`, `web.fetch`, `web.status`,
`stack.search` and `github.issues`. No API keys, no vendor SDK, no Docker,
nothing reachable from the LAN.

## How the backend runs

The search backend is a **native SearXNG** — a plain local process listening on
`127.0.0.1:8888` (no Docker required). z1 provisions and starts it itself on
first run: it installs the instance, copies
`module/assets/searxng.settings.yml` into place, generates and stores the
`SEARXNG_SECRET` privately, and brings the service up before the `web.search`
tool is used. There is nothing to launch by hand.

If it is not up, `web.search` returns one actionable line naming the URL it
tried; the fix is to let z1 provision the backend, not to start it by hand.

Probe the JSON API by hand once it is running:

```bash
curl -sS 'http://127.0.0.1:8888/search?q=typescript&format=json' | head -c 200
```

Expect HTTP 200 and a body starting `{"query": "typescript", "results": [`. If
it is HTML, `search.formats` in the deployed settings lost its `json` entry.

## Repository and install

This repository contains **only the module**. The search backend is not here:
z1 installs a native SearXNG into `~/.local/share/z1/web/searxng` on first run.
An install is therefore two steps — get the repo, then propose its `module/`:

```bash
git clone https://github.com/ayzitix/z1-web ~/Projects/z1-web
z1 module propose ~/Projects/z1-web/module
z1 module approve com.z1.web@0.3.3
```

Then enable a tool in a z1 session:

```text
/tools on web.search
```

Propose `module/` only, not the repo root: `z1 module propose` copies the whole
directory it is given, so the root would drag in the tests and this README.

The module needs a `z1-cli` at or after the commit that provisions native
SearXNG (`b64e42e`, *feat(web): provision and start a native SearXNG on
launch*). That CLI installs SearXNG, writes the settings, generates the
`SEARXNG_SECRET` privately and **starts the backend on launch** — there is no
Docker and no separate backend start step. On an older CLI the module installs
and `web.search` fails with a refused connection naming
`http://127.0.0.1:8888`.

### Grant to expect

`z1 module approve` shows this grant before accepting it:

```json
{ "net": { "hosts": ["*", "127.0.0.1:8888", "[::1]:8888"] } }
```

- `*` is **public internet only** — a wildcard is not an SSRF grant. Loopback,
  LAN, link-local and cloud-metadata targets stay denied unless the manifest
  names that exact host.
- `127.0.0.1:8888` and `[::1]:8888` are **port-scoped**: host and port must both
  match. A host-only `127.0.0.1` entry would grant every loopback port, so a
  fetched page could reach an unrelated local service such as
  `http://127.0.0.1:35545/admin`; the literal `host:port` grants SearXNG only
  and no other loopback port.
- The SDK's matcher must understand `host:port` (`checkNet` and
  `checkNetTarget`, the latter after DNS resolution). On an older SDK the entry
  does not match and SearXNG is unreachable — a visible failure, not a wider
  grant.
- `localhost` is not granted by name. With
  `Z1_SEARX_URL=http://localhost:8888`, add `"localhost:8888"` (not
  `"localhost"`, which would grant every localhost port). There is no
  filesystem, process or LLM capability in the manifest.

## Layout

```
z1-web/
  module/        # installable module: manifest.json, index.js, lib/, assets/, README.md, LICENSE
    assets/      # searxng.settings.yml — the template the native backend is configured from
  test/          # offline harness: fake ctx.net + fixtures, no backend and no network
    test-fixture.mjs     # 79 checks: five-tool contract, web.search, status
    fetch-fixture.mjs    # 27 checks: web.fetch paging/cache/refusal, status fingerprints
    html-fixture.mjs     # 42 checks: HTML extraction, forged titles, tables, links
    stack-fixture.mjs    # 28 checks: stack.search, quota and backoff clocks
    github-fixture.mjs   # 38 checks: github.issues, qualifiers, rate limit
```

Propose `module/` only. The repository root holds the test harness and the
licence, and `z1 module propose` copies the whole directory it is given. All
five test files pass: **214 checks**.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z1_SEARX_URL` | `http://127.0.0.1:8888` | Overrides the SearXNG base URL the module talks to. Credentials are stripped before it is echoed anywhere. |

The module talks to `http://127.0.0.1:8888` by default and `Z1_SEARX_URL`
overrides it. Keep the IP form: a `localhost` URL needs `"localhost:8888"`
added to `capabilities.net.hosts` in the manifest, because grants match the
normalised host **and** a port-scoped entry matches only that port.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `web.search` | `query` (required, ≤500 chars), `count` 1–20 (default 8), `site` (hostname suffix, also sent as `site:`), `language` (BCP-47 or `all`), `recency` (`day`/`week`/`month`/`year`), `safe` (boolean) | Numbered results: `N. title — url`, an indented snippet of at most 300 chars, and a `(searxng · shown of total results · ms)` footer. SearXNG serves 10 results a page, so a `count` above 10 that fills page one costs a second request and the footer says `2 pages`; a short list that was the backend's page size says `max 10 per page` instead of pretending it is complete. |
| `web.fetch` | `url` (required, absolute http(s)), `offset` (1-based character offset, default 1), `maxChars` 1000–100000 (default 50000) | A `title: TITLE — url` line (omitted when there is no title), a `(content-type · N chars · showing a–b · ms · cached: no)` footer, then the page's readable text as blocks: headings, paragraphs, lists, quotes, tables and fenced code, or a plain-text/JSON body verbatim. A cut answer ends with `offset=N` to continue. |
| `stack.search` | `query` (required, ≤500 chars), `site` (slug, default `stackoverflow`), `tags` (at most 5), `accepted` (boolean), `sort`, `limit` 1–30 (default 8) | Numbered questions with `score · N answers · accepted · tags: … · date`, and a `(site · shown of total · quota left/max)` footer. |
| `github.issues` | `query` (required, ≤500 chars), `repo` (`owner/name`), `state` (`open`/`closed`/`all`), `kind` (`issue`/`pr`/`any`), `sort`, `limit` 1–20 (default 8) | Numbered hits with `owner/repo · state · N comments · updated YYYY-MM-DD · #number`, and a `(github · shown of total · N/M requests left this minute)` footer. |
| `web.status` | none | Two lines: the SearXNG URL and `healthy`/`unhealthy` with a short reason, then that `stack.search`/`github.issues` are keyless and available without the backend, plus a note when `Z1_SEARX_URL` is overridden. Pings `/healthz` with a 3 s cap and never throws. |

Failures are one actionable line, never a stack trace: a refused connection
names the URL, a non-200 carries the status and a 200-char body excerpt, and
HTML where JSON was expected points at `search.formats: [html, json]` in the
deployed settings.

## Docs

- `module/README.md` — tools, usage, install, config, the `net.hosts` grant,
  and the honest limits.
- `module/assets/searxng.settings.yml` — the backend template: engines (google,
  bing, brave, mojeek, wikipedia, github), `safe_search: 0`, the required
  `json` format, and the list of engines that CAPTCHA on a residential IP.

## Limits (read these)

- **Scraped engines rot.** SearXNG is a metasearch front end: upstream sites
  change markup, add CAPTCHA walls or ban IPs, so individual engines silently
  stop answering. That shows up as fewer results or an `unresponsive_engines`
  list, not as a module bug. Update the backend and disable dead engines in the
  settings template.
- **Snippets are clipped at 300 characters** (titles at 160). A snippet is a
  search teaser, not the page.
- **8 results by default**, maximum 20, and **no re-ranking** — SearXNG's order
  is preserved verbatim.
- **Caches are in memory, 10 minutes, and die with the worker.** `web.fetch` is
  keyed by **URL**, not by arguments, and the whole cache holds at most **8 MiB**
  of stored text (UTF-16, roughly four ~1 MiB pages), evicting the least recently
  used entry; `offset` and `maxChars` slice the one stored page, so paging a long
  document costs one request in total and a repeat of any slice costs none.
  `web.search`, `stack.search` and `github.issues` keep their own
  parameter-keyed caches of at most 50 answers. Only successful answers are
  cached; a worker restart loses the cache.
- **Results are untrusted text.** Titles and snippets are scraped upstream and
  rendered inert, but they are still attacker-controlled content. A `web.fetch`
  body is attacker-controlled too: HTML is reduced to inert blocks and the model
  is told not to follow instructions found in a page.
- **`web.fetch` refuses PDFs and binary bodies**, naming the type and size; there
  is no JavaScript execution and no login, so a page rendered client-side comes
  back nearly empty.
- **Extraction is depth-bounded at 512 levels.** A document built deeper than
  that (60 000 nested `<div>`s) collapses to text at the limit instead of raising
  `RangeError`; the markup below the bound is flattened, not handled.
- **Only a same-origin `<base href>` is honoured.** A page that points its base
  at another host keeps every link on the URL that was actually fetched, and the
  base is dropped.
- **Only `repo:`, `state:` and `is:` are stripped from a GitHub `query`.** Those
  three are built from the tool's own `repo`, `state` and `kind` arguments, so a
  copy typed into `query` is removed; use the arguments instead. Every other
  qualifier — `label:`, `user:`, `org:`, `author:`, `milestone:` — passes
  through exactly as written.
- **A `content-type` the body contradicts is sniffed and labelled.** Static hosts
  serve HTML as `text/plain` and some APIs answer JSON under `text/html`, so the
  footer reads `text/plain (sniffed html)` or `text/html (sniffed json)` and the
  body is extracted as that type rather than dumped as source.
- **A page whose content sits in a chrome-looking container still renders.** When
  the chosen region ends up (nearly) empty because the whole body sits in a
  `menu`/`sidebar`-classed container, it is rendered again with the chrome filter
  off instead of answering "(the page returned no text)".

## Licence

MIT, Copyright (c) 2026 ayzitix. See `LICENSE`.
