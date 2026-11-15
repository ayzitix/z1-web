#!/usr/bin/env bash
# Stop the local SearXNG container. Keeps the container, the image and any
# volumes so the next start is fast. Nothing is deleted unless you pass -v.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/searxng/docker-compose.yml"

if [[ "${1:-}" == "-v" || "${1:-}" == "--volumes" ]]; then
  echo "[searx-down] stopping and removing container + named volumes"
  docker compose -f "$COMPOSE_FILE" down -v
else
  echo "[searx-down] stopping container (image and volumes kept)"
  docker compose -f "$COMPOSE_FILE" down
fi

echo "[searx-down] done. searxng/settings.yml and searxng/.env were not touched."
