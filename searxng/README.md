# SearXNG bundle (z1-web)

Self-hosted metasearch for the z1 coding agent. Everything here is deliberately
small: one container, one settings file, loopback only.

* Image: `searxng/searxng:2026.11.15-2d500cb6b`
  (`sha256:932f69dca010db9880bddebb2171f05d8e1a25d04a59149ff65409993d680024`,
  published 2026-11-15) — checked against Docker Hub on 2026-11-15.
* Port: `127.0.0.1:8888` → container `8080`.
* `/etc/searxng` is this directory (bind mount), so `settings.yml` edits apply
  on restart.

## Start / stop

From the repository root:

```bash
./scripts/searx-up.sh       # idempotent; creates .env, waits up to 60s for healthy
./scripts/searx-status.sh   # ps, health, JSON probe, RAM
./scripts/searx-down.sh     # stop, keep container/image/volumes
```

Or drive compose directly (always from this directory, so `.env` is picked up):

```bash
cd searxng
docker compose up -d
docker compose ps
docker compose logs -f --tail=50
```

## The JSON probe

```bash
curl -sS 'http://127.0.0.1:8888/search?q=typescript&format=json' | head -c 400
```

`format=json` only works because `settings.yml` sets
`search.formats: [html, json]`. The upstream default is `[html]`, and then this
same request returns `403` or an HTML page — the most common "SearXNG JSON is
broken" trap. HTML stays enabled so you can debug in a browser at
`http://127.0.0.1:8888`.

Filtering examples:

```bash
# site: works (note: other engines may still contribute off-site noise)
curl -sS 'http://127.0.0.1:8888/search?q=site:nodejs.org%20streams&format=json'
# restrict to one engine, or one category
curl -sS 'http://127.0.0.1:8888/search?q=rust%20async&format=json&engines=brave'
curl -sS 'http://127.0.0.1:8888/search?q=fastapi&format=json&categories=it'
```

## `SEARXNG_SECRET`

The Flask secret key used to sign CSRF/session data. Not committed:
`scripts/searx-up.sh` generates `settings.yml`'s value as a 32-byte hex string,
stores it in `searxng/.env` (mode `600`, git-ignored), and compose injects it as
`SEARXNG_SECRET`, which SearXNG prefers over the placeholder in `settings.yml`
(see `server.secret_key`). Regenerate any time with `rm .env && ../scripts/searx-up.sh`.

Manual setup without the script:

```bash
cp .env.example .env
printf 'SEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d
```

## Engines

Enabled in `settings.yml`: `google`, `bing`, `brave`, `mojeek`, `wikipedia`,
`github`. Notable upstream behaviour in this version:

| Engine | State here | Notes |
| --- | --- | --- |
| `google` | enabled, blocked | 2026: ships `disabled: true` upstream, so it is re-enabled explicitly; from this network it answers `403` → `access denied`, then Suspended for 180s |
| `bing` | enabled, working | returns ~10 results, good snippets |
| `brave` | enabled, working | most results of any engine here |
| `mojeek` | enabled, blocked | upstream marks it `inactive: true` (proof-of-work challenge); re-enabled on request, currently `access denied` |
| `wikipedia` | enabled, working | upstream `display_type: ["infobox"]` only; `list` added so it appears in `results` |
| `github` | enabled, working | `categories: [it, repos]` — invisible in a plain general search, use `categories=it` or `engines=github` |

Change the set by editing the `engines:` block:

```yaml
engines:
  - name: google
    disabled: true        # or just delete the enabling entry
  - name: duckduckgo
    disabled: false
```

Then `docker compose restart`. `/config` shows the *registered and enabled*
engine list:

```bash
curl -s 'http://127.0.0.1:8888/config' | python3 -c \
  'import json,sys; print([e["name"] for e in json.load(sys.stdin)["engines"] if e["enabled"]])'
```

An engine that fails at load time logs e.g.
`wikipedia engine requires general.contact_url (SEARXNG_CONTACT_URL)` — that is
why `general.contact_url` is set. `mojeek`/`ahmia`/`torch` "can't register
engine" style errors mean the module is unavailable, not that your YAML is
wrong.

### Engines that CAPTCHA on a residential IP

`google`, `bing`, `brave`, `qwant`, `startpage`, `yandex`, `duckduckgo` and the
PoW-protected `mojeek` are the usual offenders; expect `SearxEngineCaptcha` /
`SearxEngineAccessDenied` in the logs and `unresponsive_engines` in the JSON.
To silence a noisy one, add `- name: <engine>` / `disabled: true` to the
`engines:` list and restart. Suspensions last 1h–15d (`search.suspended_times`)
and are cleared by a restart.

## Settings that matter for an agent

```yaml
server.limiter: false          # single local user; limiter would 429 the agent
server.public_instance: false
search.safe_search: 0          # no filtering: keeps docs/security results
search.formats: [html, json]   # json is opt-in upstream
outgoing.request_timeout: 4.0  # per upstream
outgoing.max_request_timeout: 10.0
```

## Reset

```bash
docker compose down -v   # stop and remove container + anonymous volumes
rm -f .env               # forces a fresh secret
docker compose up -d
```

`down -v` does **not** delete `settings.yml` (bind mount) or the image.

## Maintenance

Engines rot upstream: markup changes, CAPTCHA walls, IP bans. Every few weeks:

```bash
cd searxng
docker compose pull      # gets the newest searxng/searxng tag -> new digest
docker compose up -d
# then re-pin the digest in docker-compose.yml if you care about reproducibility
```

After a bump, re-check `/config` for the enabled engine list and run the probe.
If a tag disappears, `2026.11.15-2d500cb6b` is still valid by digest.
