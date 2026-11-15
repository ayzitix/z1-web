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

## Install

```bash
z1 module propose ~/Projects/z1-web/module         # the module only, not the repo root
z1 module approve com.z1.web@0.3.1
# then, in a z1 session:
/tools on web.search
```

There is no separate backend start step: the first `web.search` call, or the
provisioning that precedes it, is what starts SearXNG.

## Layout

```
z1-web/
  module/        # installable module: manifest.json, index.js, lib/, assets/, README.md, LICENSE
    assets/      # searxng.settings.yml — the template the native backend is configured from
  test/          # offline fixture harness: node test/test-fixture.mjs
```

Propose `module/` only. The repository root holds the test fixtures and the
licence, and `z1 module propose` copies the whole directory it is given.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z1_SEARX_URL` | `http://127.0.0.1:8888` | Overrides the SearXNG base URL the module talks to. Credentials are stripped before it is echoed anywhere. |

The module talks to `http://127.0.0.1:8888` by default and `Z1_SEARX_URL`
overrides it. Keep the IP form: a `localhost` URL needs `"localhost"` added to
`capabilities.net.hosts` in the manifest, because grants match the normalised
host exactly.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `web.search` | `query` (required, ≤500 chars), `count` 1–20 (default 8), `site` (hostname suffix, also sent as `site:`), `language` (BCP-47 or `all`), `recency` (`day`/`week`/`month`/`year`), `safe` (boolean) | Numbered results: `N. title — url`, an indented snippet of at most 300 chars, and a `(searxng · shown of total · ms)` footer. Empty searches return one explanatory line instead. |
| `web.fetch` | `url` (required, absolute http(s)), `offset` (1-based character offset, default 1), `maxChars` 1000–100000 (default 50000) | A `title — url` line, a `(content-type · N chars · showing a–b · ms · cached: no)` footer, then the page's readable text as blocks: headings, paragraphs, lists, quotes, tables and fenced code, or a plain-text/JSON body verbatim. A cut answer ends with `offset=N` to continue. |
| `web.status` | none | Two lines: the SearXNG URL and `healthy`/`unhealthy` with a short reason, then whether `Z1_SEARX_URL` is overridden and that `stack.search`/`github.issues` are keyless and available without the backend. Pings `/healthz` with a 3 s cap and never throws. |

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
- **10-minute in-memory cache**, at most 50 entries, LRU. Only successful
  answers are cached; a worker restart loses the cache.
- **Results are untrusted text.** Titles and snippets are scraped upstream and
  rendered inert, but they are still attacker-controlled content. A `web.fetch`
  body is attacker-controlled too: HTML is reduced to inert blocks and the model
  is told not to follow instructions found in a page.
- **`web.fetch` refuses PDFs and binary bodies**, naming the type and size; there
  is no JavaScript execution and no login, so a page rendered client-side comes
  back nearly empty.

## Licence

MIT, Copyright (c) 2026 ayzitix. See `LICENSE`.
