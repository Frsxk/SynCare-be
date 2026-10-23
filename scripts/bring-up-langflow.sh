#!/usr/bin/env bash
# Rebuild the Langflow data directory and start a clean instance.
# Destroys local Langflow data; run deliberately.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Stopping Langflow"
docker compose down

echo "==> Removing existing Langflow data directory"
sudo rm -rf data/langflow

echo "==> Recreating with ownership for the container user (uid 1000)"
mkdir -p data/langflow
sudo chown -R 1000:1000 data/langflow

echo "==> Starting Langflow (clean database, no starter projects)"
docker compose up -d

echo "==> Waiting for health"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:7860/health 2>/dev/null || true)
  if [ "$code" = "200" ]; then
    echo "READY after ~$((i * 10))s (health=200)"
    exit 0
  fi
  sleep 10
done

echo "NOT READY. Diagnostics:"
docker ps -a --filter name=syncare-langflow --format '{{.Status}}'
docker inspect syncare-langflow --format 'RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}}'
docker logs --tail 30 syncare-langflow
exit 1