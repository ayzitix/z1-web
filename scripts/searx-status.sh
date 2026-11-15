#!/usr/bin/env bash
# Show SearXNG state and run a one-result JSON probe.
# Exit code 0 = container healthy and the JSON API returns at least one result.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/searxng/docker-compose.yml"
URL="http://127.0.0.1:8888"
CONTAINER="z1-searxng"

echo "== compose ps =="
docker compose -f "$COMPOSE_FILE" ps 2>/dev/null || echo "(compose project not running)"

echo
echo "== health =="
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  docker inspect --format 'state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$CONTAINER"
else
  echo "container $CONTAINER does not exist (run ./scripts/searx-up.sh)"
  exit 1
fi

echo
echo "== json probe ($URL/search?q=typescript&format=json) =="
body="$(curl -sS --max-time 15 "$URL/search?q=typescript&format=json" 2>&1)" || {
  echo "probe failed: request error"
  exit 1
}

if command -v python3 >/dev/null 2>&1; then
  tmp="$(mktemp)"
  printf '%s' "$body" >"$tmp"
  python3 - "$tmp" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as fh:
    raw = fh.read()

try:
    d = json.loads(raw)
except Exception:
    print("probe failed: response is not JSON:")
    print(raw[:200])
    sys.exit(1)

res = d.get("results") or []
print(f"http=200 results={len(res)}")
if res:
    r = res[0]
    print("first result:")
    print("  title  : " + str(r.get("title", ""))[:100])
    print("  url    : " + str(r.get("url", ""))[:120])
    print("  content: " + str(r.get("content") or "")[:160])
else:
    print("probe failed: JSON is valid but has no results (check engines/logs)")

ue = d.get("unresponsive_engines") or []
if ue:
    print("unresponsive engines: " + ", ".join(
        f"{e[0]} ({e[1]})" if isinstance(e, (list, tuple)) else str(e) for e in ue
    ))

sys.exit(0 if res else 1)
PY
  rc=$?
  rm -f "$tmp"
else
  printf '%s' "$body" | head -c 400
  echo
  rc=0
fi

echo
echo "== ram =="
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' 2>/dev/null | grep -E "NAME|$CONTAINER" || true

exit $rc
