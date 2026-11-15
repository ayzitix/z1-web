# z1-web

Web search for the z1 agent: a loopback-only SearXNG instance plus the
`com.z1.web` module that exposes `web.search` and `web.status`. No API keys, no
vendor SDK, nothing reachable from the LAN.

## Quickstart

```bash
./scripts/searx-up.sh                              # generate searxng/.env, start, wait for healthy
z1 module propose ~/Projects/z1-web/module         # the module only, not the repo root
z1 module approve com.z1.web@0.1.0
# then, in a z1 session:
/tools on web.search
```

The first `searx-up.sh` pulls ~200 MB and takes a little longer. Probe the JSON
API by hand:

```bash
curl -sS 'http://127.0.0.1:8888/search?q=typescript&format=json' | head -c 200
```

Expect HTTP 200 and a body starting `{"query": "typescript", "results": [`. If
it is HTML, `search.formats` in `searxng/settings.yml` lost its `json` entry.

## Layout

```
z1-web/
  module/        # installable module: manifest.json, index.js, lib/, README.md, LICENSE
  searxng/       # docker-compose.yml, settings.yml, .env.example, README.md
  scripts/       # searx-up.sh, searx-status.sh, searx-down.sh
  test/          # offline fixture harness: node test/test-fixture.mjs
```

Propose `module/` only. The repository root holds `searxng/.env` (the real
`SEARXNG_SECRET`, mode 600) and the Docker bundle, and `z1 module propose`
copies the whole directory it is given.

## Docs

- `module/README.md` — tools, usage, install, config, the `net.hosts` grant,
  and the honest limits.
- `searxng/README.md` — engines, maintenance, troubleshooting, secrets.
- `scripts/searx-status.sh` — compose ps, health, a one-result JSON probe, RAM.
- `scripts/searx-down.sh` — stop the container (keeps container and image; use
  `docker compose -f searxng/docker-compose.yml down -v` to remove volumes).

## Engine rot

SearXNG scrapes, and scrapers rot: engines start returning `access denied` or
`Suspended` as upstream sites change or ban the IP. That is not a bug in this
repo. Pull a newer image every few weeks (`cd searxng && docker compose pull &&
docker compose up -d`), check `unresponsive_engines` in
`./scripts/searx-status.sh`, and disable dead engines in `searxng/settings.yml`.

## Licence

MIT, Copyright (c) 2026 ayzitix. See `LICENSE`.
