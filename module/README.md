# com.z1.web

Web search for z1 workers, served by a local [SearXNG](https://searxng.org/)
instance. Version `0.1.0`, module id `com.z1.web`, MIT.

There is no vendor account, no API key and no cloud round trip: one `tools`
service in worker mode sends a single GET to
`{Z1_SEARX_URL}/search?format=json` through `ctx.net.request` (so the host's
allowlist, SSRF classifier, redirect re-checks and 1 MiB cap still apply) and
renders a short numbered list. SearXNG itself is started from the repository
this module lives in — see `../searxng/README.md`.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `web.search` | `query` (required, ≤500 chars), `count` 1–20 (default 8), `site` (hostname suffix, also sent as `site:`), `language` (BCP-47 or `all`), `recency` (`day`/`week`/`month`/`year`), `safe` (boolean) | Numbered results: `N. title — url`, an indented snippet of at most 300 chars, and a `(searxng · shown of total · ms)` footer. Empty searches return one explanatory line instead. |
| `web.status` | none | Two lines: the SearXNG URL and `healthy`/`unhealthy` with a short reason, then whether `Z1_SEARX_URL` is overridden and that `web.fetch` does not exist yet. Pings `/healthz` with a 3 s cap and never throws. |

Failures are one actionable line, never a stack trace: a refused connection
names the `searx-up.sh` command, a non-200 carries the status and a 200-char
body excerpt, and HTML where JSON was expected points at
`search.formats: [html, json]` in `searxng/settings.yml`.

### Example

`web.search` with `{"query": "typescript", "count": 3}`, rendered:

```text
1. TypeScript: JavaScript With Syntax For Types. — https://www.typescriptlang.org/
   TypeScript is a strongly typed programming language that builds on JavaScript, giving you better tooling at any scale. Learn how to use TypeScript to describe your data, catch errors early, and convert to JavaScript.
2. TypeScript - Wikipedia — https://en.wikipedia.org/wiki/TypeScript
   TypeScript was released to the public in October 2012, with version 0.8, after two years of internal development at Microsoft. [14][15] Soon after the initial public release, Miguel de Icaza praised the language, but criticized the lack of mature integrated development environment (IDE) support apa…
3. TypeScript Introduction - W3Schools — https://www.w3schools.com/typescript/typescript_intro.php
   What is TypeScript? TypeScript is JavaScript with one big addition: types. A type tells what kind of value something should be, like a number, a piece of text, or true/false. TypeScript help you catch mistakes early and make your code easier to understand. TypeScript was made by Microsoft in 2012,…
(searxng · 3 of 45 results · 578 ms)
```

The last line is the whole footer: provider, how many of the raw hits survived
filtering, and the upstream latency. A cache hit appends ` · cached` and repeats
the original latency. `web.status` against a running container:

```text
searxng · http://127.0.0.1:8888 · healthy · default provider · fallbacks: none configured
Z1_SEARX_URL not set (default) · web.fetch: not implemented yet
```

## Install

From a checkout of this repository (the module is the `module/` subdirectory —
never propose the repository root, which contains `searxng/.env` and the Docker
bundle):

```bash
./scripts/searx-up.sh                                   # once, from the repo root
z1 module propose ~/Projects/z1-web/module
z1 module approve com.z1.web@0.1.0
```

Then, in a z1 session, turn the tool on:

```text
/tools on web.search
```

or pick `web.search` in the tools picker. Both tools belong to the same
service; `web.status` takes no arguments and is the cheapest first check once
the module is approved. Verify the install with `z1 module list`.

`propose` copies the whole `module/` directory — `manifest.json`, `index.js`,
`lib/`, `README.md`, `LICENSE`, plus a generated `package.json` — and nothing
else.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z1_SEARX_URL` | `http://127.0.0.1:8888` | SearXNG base URL. Credentials are stripped before it is echoed anywhere. Read on every call, so an edit takes effect when the host restarts the worker. |
| `Z1_WEB_TIMEOUT_MS` | `15000` | Search deadline in ms, clamped to 250–30000 (the host aborts at 30 s). `web.status` further caps its probe at 3 s. |

## Grant to expect

`module approve` will show:

```json
{ "net": { "hosts": ["*", "127.0.0.1", "[::1]"] } }
```

- `*` means **public internet only**. A wildcard is explicitly not an SSRF
  grant: the host refuses loopback, LAN, link-local and cloud-metadata targets
  unless the manifest names that exact host.
- `127.0.0.1` and `[::1]` are those explicit literals, which is why a local
  SearXNG is reachable at all. Brackets are normalised, so `[::1]` matches the
  host `::1`.
- `localhost` is **not** granted by name, because grants match the normalised
  host exactly and `localhost` classifies as loopback. Keep the IP form: with
  `Z1_SEARX_URL=http://localhost:8888` the request is denied until you add
  `"localhost"` to `capabilities.net.hosts`. The default URL deliberately uses
  `127.0.0.1`.

Nothing else in the LAN is in scope; there is no filesystem, process or LLM
capability in the manifest.

## Limits (read these)

- **Scraped engines rot.** SearXNG is a metasearch front end: upstream sites
  change markup, add CAPTCHA walls or ban IPs, so individual engines silently
  stop answering. That shows up as fewer results or an
  `unresponsive_engines` list, not as a module bug. Pull a newer SearXNG image
  every few weeks and disable dead engines in `searxng/settings.yml`.
- **Snippets are clipped at 300 characters** (titles at 160) on code-point
  boundaries with `…` marking the cut. A snippet is a search teaser, not the
  page; that is what a fetch step is for.
- **8 results by default**, maximum 20. `count` clips after de-duplication.
- **No re-ranking.** SearXNG's order is preserved verbatim: re-scoring here
  would override the consensus of four engines with a local heuristic. The
  footer's `shown of total` tells the model whether it is seeing a slice.
- **10-minute in-memory cache**, at most 50 entries, LRU, keyed by base URL and
  every parameter. Only successful answers are cached (an empty list counts as
  an answer; an error never is), so a container that just came up is not hidden
  behind a cached failure. A worker restart loses the cache.
- **Results are untrusted text.** Titles and snippets are scraped upstream.
  They are stripped of control characters and bidi overrides, flattened to one
  line and rendered inert, but they are still attacker-controlled content: the
  tool description tells the model not to follow instructions found in them.
- **`web.fetch` is not implemented yet.** `web.status` says so. Reading a page
  body needs a separate fetch tool; the plumbing in `lib/net.js` and
  `lib/format.js` is already shaped for one.
- **No disk cache, no telemetry.** The module logs nothing and keeps no state
  outside the 50-entry in-memory map.

## Tests

The fixture harness at the repository root runs without a container or network:

```bash
node test/test-fixture.mjs   # 51 checks, fake ctx.net, fixtures only
```

## Licence

MIT, Copyright (c) 2026 ayzitix. See `LICENSE`.
